const fs = require('fs')
const path = require('path')
const dgram = require('dgram')
const { spawn } = require('child_process')
const { getSupportedRtpCapabilities } = require('mediasoup')

class MixedRecordingManager {
  constructor(room, socket) {
    this.room = room
    this.socket = socket
    this.active = new Map() // recordingId -> state
  }

  async _getFreePort() {
    async function isPortFree(port) {
      return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4')
        sock.once('error', () => {
          try {
            sock.close()
          } catch {}
          resolve(false)
        })
        sock.bind({ port, address: '127.0.0.1', exclusive: true }, () => {
          try {
            sock.close()
          } catch {}
          resolve(true)
        })
      })
    }
    for (let i = 0; i < 200; i += 1) {
      const candidate = 15000 + Math.floor(Math.random() * 40000)
      if (await isPortFree(candidate)) return candidate
    }
    throw new Error('No free UDP port available')
  }

  _buildPerInputSdp({ kind, codecName, clockRate, channels, payloadType, port, fmtp }) {
    const lines = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=FFmpegInput', 'c=IN IP4 127.0.0.1', 't=0 0']
    if (kind === 'video') {
      lines.push(
        `m=video ${port} RTP/AVP ${payloadType}`,
        `a=rtpmap:${payloadType} ${codecName}/${clockRate}`,
        `a=rtcp:${port + 1} IN IP4 127.0.0.1`,
        'a=recvonly'
      )
      if (fmtp) lines.push(`a=fmtp:${payloadType} ${fmtp}`)
    } else {
      lines.push(
        `m=audio ${port} RTP/AVP ${payloadType}`,
        `a=rtpmap:${payloadType} ${codecName}/${clockRate}/${channels || 2}`,
        `a=rtcp:${port + 1} IN IP4 127.0.0.1`,
        'a=recvonly'
      )
      if (fmtp) lines.push(`a=fmtp:${payloadType} ${fmtp}`)
    }
    return lines.join('\n') + '\n'
  }

  _codecFromRtpParameters(kind, rtpParameters) {
    if (!rtpParameters || !Array.isArray(rtpParameters.codecs)) return null
    const c = rtpParameters.codecs.find((c) => c.mimeType.toLowerCase().includes(kind))
    if (!c) return null
    const fmtp =
      c.parameters && Object.keys(c.parameters).length
        ? Object.entries(c.parameters)
            .map(([k, v]) => `${k}=${v}`)
            .join(';')
        : ''
    return {
      payloadType: c.payloadType,
      codecName: c.mimeType.split('/')[1],
      clockRate: c.clockRate,
      channels: kind === 'audio' ? c.channels || 2 : undefined,
      fmtp
    }
  }

  _computeLayout(numVideos, width, height) {
    if (numVideos <= 1) return { rows: 1, cols: 1, cellW: width, cellH: height }
    if (numVideos === 2) return { rows: 1, cols: 2, cellW: Math.floor(width / 2), cellH: height }
    if (numVideos === 3) return { rows: 2, cols: 2, cellW: Math.floor(width / 2), cellH: Math.floor(height / 2) }
    return { rows: 2, cols: 2, cellW: Math.floor(width / 2), cellH: Math.floor(height / 2) } // up to 4
  }

  _buildFilterComplex(videoCount, audioCount, targetW, targetH) {
    const { rows, cols, cellW, cellH } = this._computeLayout(videoCount, targetW, targetH)

    const scaleLabels = []
    const videoInputs = []
    for (let i = 0; i < videoCount; i += 1) {
      scaleLabels.push(
        `[${i}:v]scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease:eval=frame,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=black[v${i}]`
      )
      videoInputs.push(`[v${i}]`)
    }
    const layoutParts = []
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const idx = r * cols + c
        if (idx < videoCount) layoutParts.push(`${c * cellW}_${r * cellH}`)
      }
    }
    const xstack = `${videoInputs.join('')}xstack=inputs=${videoCount}:layout=${layoutParts.join('|')}:fill=black[v]`

    let audio = ''
    if (audioCount > 0) {
      const aInputs = Array.from({ length: audioCount }, (_, i) => `[${videoCount + i}:a]`).join('')
      audio = `${aInputs}amix=inputs=${audioCount}:normalize=0[a]`
    }

    const parts = [...scaleLabels, xstack]
    if (audio) parts.push(audio)
    return parts.join(';')
  }

  async startMixedRecording({ room_id, user_name, width = 1920, height = 1080, container = 'webm' }) {
    const router = this.room?.router
    if (!router) throw new Error('Router not initialized')

    const peers = this.room.getPeers()
    const videoProducers = []
    const audioProducers = []

    for (const [, peer] of peers) {
      for (const [, producer] of peer.producers) {
        if (producer.kind === 'video') videoProducers.push(producer)
        if (producer.kind === 'audio') audioProducers.push(producer)
      }
    }

    if (videoProducers.length === 0 && audioProducers.length === 0) {
      throw new Error('No producers to mix')
    }

    // Limit to 4 video for 2x2 grid
    const selectedVideos = videoProducers.slice(0, 4)
    const selectedAudios = audioProducers

    const recorderRtpCapabilities = getSupportedRtpCapabilities()

    // Prepare state
    const recordingId = `rec-mix-${Date.now()}`
    const containerExt = container === 'mp4' ? 'mp4' : container === 'mkv' ? 'mkv' : 'webm'
    const fileName = `mixed-${recordingId}.${containerExt}`
    const outDir = process.env.RECORD_FILE_LOCATION_PATH || './files'
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
    const sdpDir = path.join(outDir, 'sdp', recordingId)
    fs.mkdirSync(sdpDir, { recursive: true })
    const outputPath = path.join(outDir, fileName)

    const inputs = [] // { kind, sdpPath }
    const transports = []
    const consumers = []

    // Create per-video input
    for (const producer of selectedVideos) {
      if (!router.canConsume({ producerId: producer.id, rtpCapabilities: recorderRtpCapabilities })) continue
      const transport = await router.createPlainTransport({ listenIp: '127.0.0.1', rtcpMux: false, comedia: false })
      const consumer = await transport.consume({
        producerId: producer.id,
        rtpCapabilities: recorderRtpCapabilities,
        paused: true
      })

      const codecInfo = this._codecFromRtpParameters('video', consumer.rtpParameters)
      const port = await this._getFreePort()
      await transport.connect({ ip: '127.0.0.1', port, rtcpPort: port + 1 })

      const sdpText = this._buildPerInputSdp({
        kind: 'video',
        codecName: codecInfo.codecName,
        clockRate: codecInfo.clockRate,
        payloadType: codecInfo.payloadType,
        fmtp: codecInfo.fmtp,
        port
      })
      const sdpPath = path.join(sdpDir, `v-${producer.id}.sdp`)
      fs.writeFileSync(sdpPath, sdpText)

      inputs.push({ kind: 'video', sdpPath })
      transports.push(transport)
      consumers.push(consumer)
    }

    // Create per-audio input
    for (const producer of selectedAudios) {
      if (!router.canConsume({ producerId: producer.id, rtpCapabilities: recorderRtpCapabilities })) continue
      const transport = await router.createPlainTransport({ listenIp: '127.0.0.1', rtcpMux: false, comedia: false })
      const consumer = await transport.consume({
        producerId: producer.id,
        rtpCapabilities: recorderRtpCapabilities,
        paused: true
      })

      const codecInfo = this._codecFromRtpParameters('audio', consumer.rtpParameters)
      const port = await this._getFreePort()
      await transport.connect({ ip: '127.0.0.1', port, rtcpPort: port + 1 })

      const sdpText = this._buildPerInputSdp({
        kind: 'audio',
        codecName: codecInfo.codecName,
        clockRate: codecInfo.clockRate,
        channels: codecInfo.channels,
        payloadType: codecInfo.payloadType,
        fmtp: codecInfo.fmtp,
        port
      })
      const sdpPath = path.join(sdpDir, `a-${producer.id}.sdp`)
      fs.writeFileSync(sdpPath, sdpText)

      inputs.push({ kind: 'audio', sdpPath })
      transports.push(transport)
      consumers.push(consumer)
    }

    if (inputs.length === 0) throw new Error('No mixable inputs created')

    // Build ffmpeg args
    const videoCount = inputs.filter((i) => i.kind === 'video').length
    const audioCount = inputs.filter((i) => i.kind === 'audio').length

    const ffArgs = [
      '-nostdin',
      '-y',
      '-loglevel',
      'info',
      '-protocol_whitelist',
      'file,udp,rtp',
      '-fflags',
      '+genpts',
      '-analyzeduration',
      '15000000',
      '-probesize',
      '15000000'
    ]

    for (const inp of inputs) {
      ffArgs.push('-f', 'sdp', '-i', inp.sdpPath)
    }

    const filter = this._buildFilterComplex(videoCount, audioCount, width, height)
    ffArgs.push('-filter_complex', filter)
    ffArgs.push('-map', '[v]')
    if (audioCount > 0) ffArgs.push('-map', '[a]')

    if (containerExt === 'mp4') {
      ffArgs.push(
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-tune',
        'zerolatency',
        '-profile:v',
        'baseline',
        '-pix_fmt',
        'yuv420p',
        '-g',
        '50',
        '-keyint_min',
        '50',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart+frag_keyframe+empty_moov',
        outputPath
      )
    } else if (containerExt === 'mkv') {
      ffArgs.push(
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-g',
        '50',
        '-keyint_min',
        '50',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '128k',
        outputPath
      )
    } else {
      ffArgs.push(
        '-c:v',
        'libvpx',
        '-b:v',
        '2500k',
        '-crf',
        '30',
        '-r',
        '30',
        '-pix_fmt',
        'yuv420p',
        '-deadline',
        'realtime',
        '-c:a',
        'libopus',
        '-b:a',
        '128k',
        outputPath
      )
    }

    // Start FFmpeg
    const ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    ff.stderr.setEncoding('utf-8')
    ff.stderr.on('data', (d) => console.log('[mix ffmpeg]', d.trim()))
    ff.on('close', () => console.log('[mix ffmpeg] closed'))

    // Resume consumers and request keyframes
    for (const consumer of consumers) {
      try {
        await consumer.resume()
        if (consumer.kind === 'video') {
          try {
            await consumer.requestKeyFrame()
          } catch {}
        }
      } catch {}
    }

    const state = {
      recordingId,
      fileName,
      outputPath,
      sdpDir,
      transports,
      consumers,
      ff
    }
    this.active.set(recordingId, state)

    return { success: true, recording_id: recordingId, file_name: fileName, file_path: outputPath }
  }

  async stopMixedRecording({ recording_id }) {
    const st = this.active.get(recording_id)
    if (!st) return { success: false, error: 'Not found' }

    try {
      st.ff.kill('SIGINT')
    } catch {}
    for (const c of st.consumers) {
      try {
        await c.close()
      } catch {}
    }
    for (const t of st.transports) {
      try {
        await t.close()
      } catch {}
    }
    try {
      // Cleanup SDP files
      if (fs.existsSync(st.sdpDir)) {
        for (const f of fs.readdirSync(st.sdpDir)) {
          fs.unlinkSync(path.join(st.sdpDir, f))
        }
        fs.rmdirSync(st.sdpDir, { recursive: true })
      }
    } catch {}

    this.active.delete(recording_id)
    const exists = fs.existsSync(st.outputPath)

    return { success: true, file_name: st.fileName, file_path: st.outputPath, file_exists: exists }
  }
}

module.exports = MixedRecordingManager
