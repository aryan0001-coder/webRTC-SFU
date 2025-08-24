const fs = require('fs')
const path = require('path')
const dgram = require('dgram')
const { spawn } = require('child_process')
const { getSupportedRtpCapabilities } = require('mediasoup')

class MixedRecordingManager {
  constructor(room, socket) {
    this.room = room
    this.socket = socket
    this.active = new Map()
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
    const c = rtpParameters.codecs.find((x) => x.mimeType.toLowerCase().includes(kind))
    if (!c) return null
    const fmtp =
      c.parameters && Object.keys(c.parameters).length
        ? Object.entries(c.parameters)
            .map(([k, v]) => `${k}=${v}`)
            .join(';')
        : ''
    const codecName = c.mimeType.split('/')[1]
    return {
      payloadType: c.payloadType,
      codecName,
      clockRate: c.clockRate,
      channels: kind === 'audio' ? c.channels || 2 : undefined,
      fmtp
    }
  }

  _computeLayout(numVideos, width, height) {
    if (numVideos <= 1) return { rows: 1, cols: 1, cellW: width, cellH: height }
    if (numVideos === 2) return { rows: 1, cols: 2, cellW: Math.floor(width / 2), cellH: height }
    if (numVideos === 3) return { rows: 2, cols: 2, cellW: Math.floor(width / 2), cellH: Math.floor(height / 2) }
    return { rows: 2, cols: 2, cellW: Math.floor(width / 2), cellH: Math.floor(height / 2) }
  }

  _buildFilterComplex(videoCount, audioCount, targetW, targetH) {
    const { rows, cols, cellW, cellH } = this._computeLayout(videoCount, targetW, targetH)
    const parts = []

    // Per-video: normalize fps/SAR, scale+pad to grid cell, add small start pad
    const videoLabels = []
    for (let i = 0; i < videoCount; i += 1) {
      parts.push(
        `[${i}:v]` +
          `scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease:eval=frame,` +
          `pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=black,` +
          `fps=25,setsar=1,format=yuv420p[v${i}]`
      )
      videoLabels.push(`[v${i}]`)
    }

    const layoutParts = []
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const idx = r * cols + c
        if (idx < videoCount) layoutParts.push(`${c * cellW}_${r * cellH}`)
      }
    }
    parts.push(
      `${videoLabels.join('')}xstack=inputs=${videoCount}:layout=${layoutParts.join('|')}:fill=black:shortest=0[vtmp]`
    )
    parts.push(`[vtmp]setpts=PTS-STARTPTS[vout]`)

    if (audioCount > 0) {
      const audioLabels = []
      for (let j = 0; j < audioCount; j += 1) {
        const aIndex = videoCount + j
        parts.push(`[${aIndex}:a]aresample=async=1:min_hard_comp=0.100:first_pts=0[a${j}]`)
        audioLabels.push(`[a${j}]`)
      }
      if (audioCount === 1) {
        parts.push(`${audioLabels[0]}asetpts=PTS-STARTPTS[aout]`)
      } else {
        parts.push(
          `${audioLabels.join('')}amix=inputs=${audioCount}:normalize=0:duration=longest:dropout_transition=2[amix]`
        )
        parts.push(`[amix]asetpts=PTS-STARTPTS[aout]`)
      }
    }

    return parts.join(';')
  }

  async _waitForProcessClose(child, timeoutMs) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return true
    return await new Promise((resolve) => {
      let settled = false
      const onClose = () => {
        if (!settled) {
          settled = true
          resolve(true)
        }
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          child.off('close', onClose)
        } catch {}
        resolve(false)
      }, timeoutMs)
      child.once('close', () => {
        try {
          clearTimeout(timer)
        } catch {}
        onClose()
      })
    })
  }

  async startMixedRecording({ room_id, user_name, width = 1280, height = 720 }) {
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
    if (videoProducers.length === 0 && audioProducers.length === 0) throw new Error('No producers to mix')

    const selectedVideos = videoProducers.slice(0, 4)
    const selectedAudios = audioProducers
    const rtpCaps = getSupportedRtpCapabilities()

    const recordingId = `rec-mix-${Date.now()}`
    const fileName = `mixed-${recordingId}.mp4`
    const outDir = process.env.RECORD_FILE_LOCATION_PATH || './files'
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
    const sdpDir = path.join(outDir, 'sdp', recordingId)
    fs.mkdirSync(sdpDir, { recursive: true })
    const outputPath = path.join(outDir, fileName)

    const inputs = []
    const transports = []
    const consumers = []

    for (const producer of selectedVideos) {
      if (!router.canConsume({ producerId: producer.id, rtpCapabilities: rtpCaps })) continue
      const transport = await router.createPlainTransport({ listenIp: '127.0.0.1', rtcpMux: false, comedia: false })
      const consumer = await transport.consume({ producerId: producer.id, rtpCapabilities: rtpCaps, paused: true })
      const codecInfo = this._codecFromRtpParameters('video', consumer.rtpParameters)
      if (!codecInfo) {
        try {
          await transport.close()
        } catch {}
        continue
      }
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

    // Audio inputs
    for (const producer of selectedAudios) {
      if (!router.canConsume({ producerId: producer.id, rtpCapabilities: rtpCaps })) continue
      const transport = await router.createPlainTransport({ listenIp: '127.0.0.1', rtcpMux: false, comedia: false })
      const consumer = await transport.consume({ producerId: producer.id, rtpCapabilities: rtpCaps, paused: true })
      const codecInfo = this._codecFromRtpParameters('audio', consumer.rtpParameters)
      if (!codecInfo) {
        try {
          await transport.close()
        } catch {}
        continue
      }
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

    const videoCount = inputs.filter((i) => i.kind === 'video').length
    const audioCount = inputs.filter((i) => i.kind === 'audio').length

    const ffArgs = [
      '-y',
      '-loglevel',
      'info',
      '-fflags',
      '+genpts+nobuffer',
      '-flags',
      'low_delay',
      '-max_delay',
      '0',
      '-analyzeduration',
      '1000000',
      '-probesize',
      '1000000'
    ]

    // Per SDP input
    for (const inp of inputs) {
      ffArgs.push(
        '-thread_queue_size',
        '1024',
        '-protocol_whitelist',
        'file,crypto,data,udp,rtp',
        '-f',
        'sdp',
        '-i',
        inp.sdpPath
      )
    }

    const filter = this._buildFilterComplex(videoCount, audioCount, width, height)
    ffArgs.push('-filter_complex', filter)
    ffArgs.push('-map', '[vout]')
    if (audioCount > 0) ffArgs.push('-map', '[aout]')

    // Realtime-friendly H.264/AAC MP4
    ffArgs.push(
      '-use_wallclock_as_timestamps',
      '1',
      '-muxpreload',
      '0',
      '-muxdelay',
      '0',
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
      '+faststart',
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      outputPath
    )

    const ff = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'pipe', 'pipe'] })
    ff.stderr.setEncoding('utf-8')
    ff.stderr.on('data', (d) => console.log('[mix ffmpeg stderr]', d.trim()))
    ff.on('error', (err) => console.error('[mix ffmpeg error]', err))
    ff.on('close', () => console.log('[mix ffmpeg] closed'))
    ff.on('exit', (code, signal) => console.log('[mix ffmpeg] exit', { code, signal }))

    for (const consumer of consumers) {
      consumer.on('transportclose', () => console.error('[mix ffmpeg] Consumer transport closed:', consumer.id))
      consumer.on('producerclose', () => console.error('[mix ffmpeg] Producer closed:', consumer.producerId))
      try {
        await consumer.resume()
        if (consumer.kind === 'video') {
          try {
            await consumer.requestKeyFrame()
          } catch {}
        }
      } catch {}
    }
    const keyframeIntervals = []
    for (const consumer of consumers) {
      if (consumer.kind === 'video') {
        const h = setInterval(() => {
          consumer.requestKeyFrame().catch((err) => console.error('[mix ffmpeg] Keyframe request failed:', err))
        }, 2000)
        keyframeIntervals.push(h)
      }
    }

    const state = {
      recordingId,
      fileName,
      outputPath,
      sdpDir,
      transports,
      consumers,
      ff,
      keyframeIntervals,
      startedAt: Date.now()
    }
    this.active.set(recordingId, state)

    return { success: true, recording_id: recordingId, file_name: fileName, file_path: outputPath }
  }

  async stopMixedRecording({ recording_id }) {
    const st = this.active.get(recording_id)
    if (!st) return { success: false, error: 'Not found' }

    // Ensure minimum recording time
    const minRunMs = 20000 // Increased to 20s
    const elapsed = Date.now() - (st.startedAt || Date.now())
    if (elapsed < minRunMs) await new Promise((r) => setTimeout(r, minRunMs - elapsed))

    let exited = await this._waitForProcessClose(st.ff, 300)
    if (!exited) {
      try {
        if (st.ff.stdin && !st.ff.stdin.destroyed) {
          st.ff.stdin.write('q\n')
          st.ff.stdin.end()
        }
      } catch {}
      exited = await this._waitForProcessClose(st.ff, 30000)
    }

    // If still running, close mediasoup resources
    if (!exited) {
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
      exited = await this._waitForProcessClose(st.ff, 5000)
    }

    // Clear keyframe timers
    if (st.keyframeIntervals) {
      for (const h of st.keyframeIntervals) clearInterval(h)
    }

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

    this.active.delete(recording_id)

    // Check output file duration
    const checkDuration = () => {
      return new Promise((resolve) => {
        const probe = spawn(
          'ffprobe',
          ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', st.outputPath],
          { stdio: ['pipe', 'pipe', 'pipe'] }
        )
        let output = ''
        probe.stdout.on('data', (data) => (output += data))
        probe.on('close', () => {
          try {
            const json = JSON.parse(output)
            const duration = parseFloat(json.format?.duration || 0)
            console.log(`[mix ffmpeg] Output duration: ${duration}s`)
            resolve(duration)
          } catch {
            resolve(0)
          }
        })
      })
    }
    const duration = await checkDuration()

    // Cleanup SDP directory
    const sdpDir = st.sdpDir
    setTimeout(() => {
      try {
        if (sdpDir) fs.rmSync(sdpDir, { recursive: true, force: true })
      } catch {}
    }, 1500)

    const exists = fs.existsSync(st.outputPath)
    return { success: true, file_name: st.fileName, file_path: st.outputPath, file_exists: exists, duration }
  }
}

module.exports = MixedRecordingManager
