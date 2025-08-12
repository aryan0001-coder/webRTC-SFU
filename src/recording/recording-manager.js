const FFmpeg = require('./ffmpeg')
const { createSdpText } = require('./sdp')
const { convertStringToStream } = require('./utils')
const path = require('path')
const fs = require('fs')

class RecordingManager {
  constructor(room, socket) {
    this.room = room
    this.socket = socket
    this.activeRecordings = new Map()
    this.recordingTransports = new Map()
  }

  async startRecording(data) {
    try {
      const { room_id, user_name } = data

      if (!this.room) {
        throw new Error('Room not initialized')
      }

      // Get router directly from room
      const router = this.room.router
      if (!router) {
        throw new Error('Router not initialized')
      }

      // Check if router has the createPlainTransport method
      if (typeof router.createPlainTransport !== 'function') {
        console.error('Router object:', router)
        console.error('Router methods:', Object.keys(router))
        throw new Error('router.createPlainTransport is not a function')
      }

      // Create a recording transport
      const transport = await router.createPlainTransport({
        listenIp: '127.0.0.1',
        rtcpMux: false,
        comedia: false
      })

      const recordingId = `rec-${Date.now()}`
      const fileName = `recording-${recordingId}.mp4`
      console.log('recordingid', recordingId)
      console.log('filename', fileName)
      //console.log('filepath', filePath)

      const filePath = path.join('files', fileName)

      // Ensure directory exists
      const recordDir = process.env.RECORD_FILE_LOCATION_PATH || './files'
      if (!fs.existsSync(recordDir)) {
        fs.mkdirSync(recordDir, { recursive: true })
      }

      // Get RTP capabilities
      const rtpCapabilities = this.room.router.rtpCapabilities

      // Get actual codecs from producers instead of router capabilities
      const peers = this.room.getPeers()
      let videoCodec = null
      let audioCodec = null

      for (const [peerId, peer] of peers) {
        for (const [producerId, producer] of peer.producers) {
          if (producer.kind === 'video' && !videoCodec) {
            videoCodec = producer.rtpParameters
          }
          if (producer.kind === 'audio' && !audioCodec) {
            audioCodec = producer.rtpParameters
          }
        }
      }

      if (!videoCodec && !audioCodec) {
        throw new Error('No video or audio producers found for recording')
      }

      // Create RTP parameters for FFmpeg with null checks
      if (!transport.tuple || !transport.tuple.localPort) {
        throw new Error('Transport tuple or localPort is undefined')
      }

      const rtpParameters = {
        videoCodec,
        audioCodec,
        remoteRtpPort: transport.tuple.localPort,
        remoteRtcpPort: transport.tuple.localPort + 1,
        localRtpPort: transport.tuple.localPort,
        localRtcpPort: transport.tuple.localPort + 1,
        fileName,
        filePath
      }

      console.log('Starting FFmpeg with filePath:', filePath)

      // Create FFmpeg instance
      const ffmpeg = new FFmpeg(rtpParameters)

      // Store recording info
      this.activeRecordings.set(recordingId, {
        ffmpeg,
        transport,
        fileName,
        filePath,
        startTime: Date.now(),
        room_id,
        user_name,
        producers: []
      })

      // Connect all existing producers to this recording
      await this.connectProducersToRecording(recordingId)

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

      // Close all producers
      for (const producer of recording.producers) {
        try {
          await producer.close()
        } catch (e) {
          console.error('Error closing producer:', e)
        }
      }

      // Stop FFmpeg
      recording.ffmpeg.kill()

      // Close transport
      try {
        await recording.transport.close()
      } catch (e) {
        console.error('Error closing transport:', e)
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

  async connectProducersToRecording(recordingId) {
    const recording = this.activeRecordings.get(recordingId)
    if (!recording) return

    // Get all active producers in the room
    const peers = this.room.getPeers()
    const producers = []

    console.log('Peers in room:', peers.size)

    for (const [peerId, peer] of peers) {
      for (const [producerId, producer] of peer.producers) {
        if (producer.kind === 'video' || producer.kind === 'audio') {
          producers.push(producer)
        }
      }
    }

    console.log('Producers found:', producers.length)

    // Connect each producer to the recording
    for (const producer of producers) {
      try {
        // Skip producers without valid RTP parameters
        if (
          !producer.rtpParameters ||
          !producer.rtpParameters.codecs ||
          !Array.isArray(producer.rtpParameters.codecs) ||
          producer.rtpParameters.codecs.length === 0
        ) {
          console.warn(`Skipping producer ${producer.id} - no valid codecs found`)
          continue
        }

        // Create proper RTP parameters for the consumer using mediasoup's expected format
        const codec = producer.rtpParameters.codecs[0]

        // Build the RTP parameters in the format mediasoup expects
        const consumerRtpParameters = {
          codecs: [codec],
          encodings: producer.rtpParameters.encodings || [{}],
          headerExtensions: producer.rtpParameters.headerExtensions || []
        }

        console.log(`Using codec for producer ${producer.id}:`, codec)

        // Create consumer with proper RTP parameters
        const consumer = await recording.transport.consume({
          producerId: producer.id,
          rtpParameters: consumerRtpParameters,
          paused: false
        })

        // Resume the consumer
        await consumer.resume()

        // Add to recording producers
        recording.producers.push(consumer)

        console.log(`Connected ${producer.kind} producer to recording: ${producer.id}`)
      } catch (error) {
        console.error(`Error connecting producer ${producer.id} to recording:`, error)
      }
    }
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
