const FFmpeg = require('./ffmpeg')
const { createSdpText } = require('./sdp')
const { convertStringToStream } = require('./utils')
const path = require('path')
const fs = require('fs')
const dgram = require('dgram')
const { getSupportedRtpCapabilities } = require('mediasoup')

class RecordingManager {
  constructor(room, socket) {
    this.room = room
    this.socket = socket
    this.activeRecordings = new Map()
    this.recordingTransports = new Map()
  }

  async _getFreeBasePort() {
    // Find a UDP base port P such that P and P+2 are free (for video and audio)
    async function isPortFree(port) {
      return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4')
        sock.once('error', () => {
          try { sock.close() } catch {}
          resolve(false)
        })
        sock.bind({ port, address: '127.0.0.1', exclusive: true }, () => {
          const ok = true
          try { sock.close() } catch {}
          resolve(ok)
        })
      })
    }

    for (let attempts = 0; attempts < 50; attempts += 1) {
      const candidate = 10000 + Math.floor(Math.random() * 40000)
      const ok1 = await isPortFree(candidate)
      const ok2 = await isPortFree(candidate + 2)
      if (ok1 && ok2) return candidate
    }
    throw new Error('Unable to allocate free UDP ports for recording')
  }

  async startRecording(data) {
    try {
      const { room_id, user_name } = data

      if (!this.room) {
        throw new Error('Room not initialized')
      }

      const router = this.room.router
      if (!router) {
        throw new Error('Router not initialized')
      }

      const recordingId = `rec-${Date.now()}`
      const fileName = `recording-${recordingId}.webm`
      console.log('recordingid', recordingId)
      console.log('filename', fileName)

      const filePath = path.join('files', fileName)

      // Ensure directory exists
      const recordDir = process.env.RECORD_FILE_LOCATION_PATH || './files'
      if (!fs.existsSync(recordDir)) {
        fs.mkdirSync(recordDir, { recursive: true })
      }

      // Get actual codecs from producers instead of router capabilities
      const peers = this.room.getPeers()
      let hasVideo = false
      let hasAudio = false

      for (const [, peer] of peers) {
        for (const [, producer] of peer.producers) {
          if (producer.kind === 'video') hasVideo = true
          if (producer.kind === 'audio') hasAudio = true
        }
      }

      if (!hasVideo && !hasAudio) {
        throw new Error('No video or audio producers found for recording')
      }

      // Pick free UDP ports for FFmpeg to receive on
      const basePort = await this._getFreeBasePort()
      const ffmpegVideoPort = basePort
      const ffmpegAudioPort = basePort + 2

      // Create separate plain transports per kind so ports match the SDP
      let videoTransport = null
      let audioTransport = null

      if (hasVideo) {
        videoTransport = await router.createPlainTransport({ listenIp: '127.0.0.1', rtcpMux: false, comedia: false })
        await videoTransport.connect({ ip: '127.0.0.1', port: ffmpegVideoPort, rtcpPort: ffmpegVideoPort + 1 })
      }

      if (hasAudio) {
        audioTransport = await router.createPlainTransport({ listenIp: '127.0.0.1', rtcpMux: false, comedia: false })
        await audioTransport.connect({ ip: '127.0.0.1', port: ffmpegAudioPort, rtcpPort: ffmpegAudioPort + 1 })
      }

      // Store recording info early (without ffmpeg yet)
      this.activeRecordings.set(recordingId, {
        ffmpeg: null,
        videoTransport,
        audioTransport,
        fileName,
        filePath,
        startTime: Date.now(),
        room_id,
        user_name,
        producers: [],
        videoRtpParameters: null,
        audioRtpParameters: null
      })

      // Connect all existing producers to this recording and get consumer RTP params
      const { videoRtpParameters, audioRtpParameters } = await this._connectAndCollectRtp(recordingId)

      // Build FFmpeg RTP parameters using consumer-assigned payload types
      const ffmpegRtpParams = {
        videoCodec: videoRtpParameters || undefined,
        audioCodec: audioRtpParameters || undefined,
        remoteRtpPort: ffmpegVideoPort,
        remoteAudioRtpPort: audioRtpParameters ? ffmpegAudioPort : undefined,
        fileName,
        filePath
      }

      console.log('Starting FFmpeg with filePath:', filePath)

      const ffmpeg = new FFmpeg(ffmpegRtpParams)

      // Update stored recording with ffmpeg instance
      const rec = this.activeRecordings.get(recordingId)
      if (rec) rec.ffmpeg = ffmpeg

      // Now resume consumers and request keyframes for video
      if (rec) {
        for (const consumer of rec.producers) {
          try {
            await consumer.resume()
            if (consumer.kind === 'video') {
              try { await consumer.requestKeyFrame() } catch (e) { console.warn('requestKeyFrame failed:', e?.message || e) }
            }
          } catch (e) {
            console.warn('Failed to resume consumer:', e?.message || e)
          }
        }
      }

      return {
        success: true,
        recording_id: recordingId,
        file_name: fileName,
        message: 'Recording started successfully'
      }
    } catch (error) {
      console.error('Start recording error:', error)
      throw new Error(error.message || 'Failed to start recording')
    }
  }

  async stopRecording(data) {
    try {
      const { recording_id } = data

      if (!this.activeRecordings.has(recording_id)) {
        throw new Error('Recording not found')
      }

      const recording = this.activeRecordings.get(recording_id)

      // Close all consumers
      for (const consumer of recording.producers) {
        try {
          await consumer.close()
        } catch (e) {
          console.error('Error closing consumer:', e)
        }
      }

      // Stop FFmpeg
      if (recording.ffmpeg) recording.ffmpeg.kill()

      // Close transports
      try {
        if (recording.videoTransport) await recording.videoTransport.close()
      } catch (e) {
        console.error('Error closing video transport:', e)
      }
      try {
        if (recording.audioTransport) await recording.audioTransport.close()
      } catch (e) {
        console.error('Error closing audio transport:', e)
      }

      // Check if file exists
      const fileExists = fs.existsSync(recording.filePath)

      // Clean up
      this.activeRecordings.delete(recording_id)

      return {
        success: true,
        file_name: recording.fileName,
        file_path: recording.filePath,
        file_exists: fileExists,
        duration: Date.now() - recording.startTime,
        message: 'Recording stopped successfully'
      }
    } catch (error) {
      console.error('Stop recording error:', error)
      throw new Error(error.message || 'Failed to stop recording')
    }
  }

  async _connectAndCollectRtp(recordingId) {
    const recording = this.activeRecordings.get(recordingId)
    if (!recording) return { videoRtpParameters: null, audioRtpParameters: null }

    const peers = this.room.getPeers()
    const producers = []

    console.log('Peers in room:', peers.size)

    for (const [, peer] of peers) {
      for (const [, producer] of peer.producers) {
        if (producer.kind === 'video' || producer.kind === 'audio') {
          producers.push(producer)
        }
      }
    }

    console.log('Producers found:', producers.length)

    const router = this.room.router
    const recorderRtpCapabilities = getSupportedRtpCapabilities()

    let videoRtpParameters = null
    let audioRtpParameters = null

    for (const producer of producers) {
      try {
        if (!router.canConsume({ producerId: producer.id, rtpCapabilities: recorderRtpCapabilities })) {
          console.warn(`Recorder cannot consume producer ${producer.id}`)
          continue
        }

        const transport = producer.kind === 'video' ? recording.videoTransport : recording.audioTransport
        if (!transport) {
          console.warn(`No transport available for ${producer.kind} producer ${producer.id}`)
          continue
        }

        const consumer = await transport.consume({
          producerId: producer.id,
          rtpCapabilities: recorderRtpCapabilities,
          paused: true
        })

        // Do not resume yet; wait until FFmpeg is ready
        recording.producers.push(consumer)

        if (producer.kind === 'video') {
          videoRtpParameters = consumer.rtpParameters
        } else if (producer.kind === 'audio') {
          audioRtpParameters = consumer.rtpParameters
        }

        console.log(`Connected ${producer.kind} producer to recording: ${producer.id}`)
      } catch (error) {
        console.error(`Error connecting producer ${producer.id} to recording:`, error)
      }
    }

    // Save for diagnostics if needed
    recording.videoRtpParameters = videoRtpParameters
    recording.audioRtpParameters = audioRtpParameters

    return { videoRtpParameters, audioRtpParameters }
  }

  getRecordingStatus(recordingId) {
    if (!this.activeRecordings.has(recordingId)) {
      return null
    }

    const recording = this.activeRecordings.get(recordingId)
    return {
      recording_id: recordingId,
      is_active: true,
      start_time: recording.startTime,
      duration: Date.now() - recording.startTime,
      file_name: recording.fileName,
      producers_count: recording.producers.length
    }
  }

  getActiveRecordings() {
    const recordings = []
    for (const [recordingId, recording] of this.activeRecordings) {
      recordings.push({
        recording_id: recordingId,
        start_time: recording.startTime,
        duration: Date.now() - recording.startTime,
        file_name: recording.fileName,
        room_id: recording.room_id,
        user_name: recording.user_name
      })
    }
    return recordings
  }
}

module.exports = RecordingManager
