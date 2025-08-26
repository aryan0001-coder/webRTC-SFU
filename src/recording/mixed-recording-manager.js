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
    const lines = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=FFmpegInput', 'c=IN IP4 127.0.0.1', 't=0 0', 'a=recvonly']

    if (kind === 'video') {
      lines.push(
        `m=video ${port} RTP/AVP ${payloadType}`,
        `a=rtpmap:${payloadType} ${codecName}/${clockRate}`,
        `a=rtcp:${port + 1} IN IP4 127.0.0.1`,
        'a=recvonly',
        'a=ptime:20',
        'a=maxptime:40'
      )
      if (fmtp) lines.push(`a=fmtp:${payloadType} ${fmtp}`)
    } else {
      lines.push(
        `m=audio ${port} RTP/AVP ${payloadType}`,
        `a=rtpmap:${payloadType} ${codecName}/${clockRate}/${channels || 2}`,
        `a=rtcp:${port + 1} IN IP4 127.0.0.1`,
        'a=recvonly',
        'a=ptime:20',
        'a=maxptime:40'
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
          `fps=30:round=up,setsar=1,format=yuv420p[v${i}]`
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
      `${videoLabels.join('')}xstack=inputs=${videoCount}:layout=${layoutParts.join('|')}:fill=black:shortest=1[vtmp]`
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
          `${audioLabels.join('')}amix=inputs=${audioCount}:normalize=0:duration=first:dropout_transition=0[amix]`
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

    // Ensure output directory exists and is writable
    if (!fs.existsSync(outDir)) {
      try {
        fs.mkdirSync(outDir, { recursive: true })
        console.log(`[mix ffmpeg] Created output directory: ${outDir}`)
      } catch (err) {
        console.error(`[mix ffmpeg] Failed to create output directory: ${outDir}`, err)
        throw new Error(`Cannot create output directory: ${err.message}`)
      }
    }

    // Check if directory is writable
    try {
      const testFile = path.join(outDir, '.test-write')
      fs.writeFileSync(testFile, 'test')
      fs.unlinkSync(testFile)
    } catch (err) {
      console.error(`[mix ffmpeg] Output directory is not writable: ${outDir}`, err)
      throw new Error(`Output directory is not writable: ${err.message}`)
    }

    const sdpDir = path.join(outDir, 'sdp', recordingId)
    fs.mkdirSync(sdpDir, { recursive: true })
    const outputPath = path.join(outDir, fileName)

    console.log(`[mix ffmpeg] Recording will be saved to: ${outputPath}`)

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
      '+genpts+nobuffer+discardcorrupt',
      '-flags',
      'low_delay',
      '-max_delay',
      '0',
      '-analyzeduration',
      '100000',
      '-probesize',
      '100000',
      '-re'
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

    // Realtime-friendly H.264/AAC MP4 - output options
    ffArgs.push(
      '-fps_mode',
      'cfr',
      '-async',
      '1',
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
      '30',
      '-keyint_min',
      '30',
      '-bf',
      '0',
      '-refs',
      '1',
      '-x264opts',
      'no-scenecut=1:nal-hrd=cbr',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-movflags',
      '+faststart+frag_keyframe+empty_moov',
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      outputPath
    )

    const ff = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'pipe', 'pipe'] })
    ff.stderr.setEncoding('utf-8')

    // Enhanced FFmpeg logging
    let ffmpegLogs = []
    let hasStarted = false
    let hasError = false

    ff.stderr.on('data', (d) => {
      const logLine = d.trim()
      ffmpegLogs.push(logLine)
      console.log('[mix ffmpeg stderr]', logLine)

      // Check for common FFmpeg issues
      if (logLine.includes('frame=') && logLine.includes('fps=')) {
        console.log('[mix ffmpeg] Frame info:', logLine)
        if (!hasStarted) {
          hasStarted = true
          console.log('[mix ffmpeg] FFmpeg started processing frames')
        }
      }
      if (logLine.includes('error') || logLine.includes('Error')) {
        console.error('[mix ffmpeg] Error detected:', logLine)
        hasError = true
      }
      if (logLine.includes('dropping frame')) {
        console.warn('[mix ffmpeg] Frame dropping detected:', logLine)
      }
      if (logLine.includes('Received no start marker')) {
        console.warn('[mix ffmpeg] SDP start marker issue:', logLine)
      }
      if (logLine.includes('Invalid argument')) {
        console.error('[mix ffmpeg] Invalid argument error:', logLine)
        hasError = true
      }
    })

    ff.on('error', (err) => {
      console.error('[mix ffmpeg error]', err)
      hasError = true
    })

    ff.on('close', (code, signal) => {
      console.log('[mix ffmpeg] closed with code:', code, 'signal:', signal)
      if (code !== 0) {
        console.error('[mix ffmpeg] Non-zero exit code, logs:', ffmpegLogs.slice(-10))
        hasError = true
      }
    })
    ff.on('exit', (code, signal) => {
      console.log('[mix ffmpeg] exit', { code, signal })
      if (code !== 0) {
        hasError = true
      }
    })

    // Check if FFmpeg failed to start properly
    setTimeout(() => {
      if (hasError && !hasStarted) {
        console.error('[mix ffmpeg] FFmpeg failed to start properly')
        console.error('[mix ffmpeg] Command args:', ffArgs.join(' '))

        // Try to get more info about the failure
        if (ffmpegLogs.length > 0) {
          console.error('[mix ffmpeg] Last 5 log lines:', ffmpegLogs.slice(-5))
        }
      }
    }, 2000)

    // Wait a bit for FFmpeg to initialize before starting consumers
    await new Promise((resolve) => setTimeout(resolve, 500))

    for (const consumer of consumers) {
      consumer.on('transportclose', () => console.error('[mix ffmpeg] Consumer transport closed:', consumer.id))
      consumer.on('producerclose', () => console.error('[mix ffmpeg] Producer closed:', consumer.producerId))

      // Set RTP timing parameters for better synchronization
      if (consumer.rtpParameters && consumer.rtpParameters.rtcp) {
        try {
          // Enable RTCP feedback for better timing
          console.log(`[mix ffmpeg] Consumer ${consumer.id} RTP parameters:`, {
            kind: consumer.kind,
            rtpStreamId: consumer.rtpStreamId,
            rtpParameters: consumer.rtpParameters
          })
        } catch (e) {
          console.warn('[mix ffmpeg] Could not log RTP parameters:', e.message)
        }
      }

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
        }, 1000) // Reduced from 2000ms to 1000ms for better sync
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
      startedAt: Date.now(),
      ffmpegStartedAt: null,
      ffmpegLogs: ffmpegLogs,
      frameStats: {
        totalFrames: 0,
        droppedFrames: 0,
        lastFrameTime: null
      }
    }
    this.active.set(recordingId, state)

    // Monitor FFmpeg performance
    const monitorInterval = setInterval(() => {
      const currentState = this.active.get(recordingId)
      if (currentState && currentState.ff && currentState.ff.pid && ffmpegLogs.length > 0) {
        const recentLogs = ffmpegLogs.slice(-5)
        const frameLog = recentLogs.find((log) => log.includes('frame='))
        if (frameLog) {
          const frameMatch = frameLog.match(/frame=\s*(\d+)/)
          if (frameMatch) {
            const currentFrames = parseInt(frameMatch[1])
            if (currentState.frameStats.lastFrameTime) {
              const timeDiff = Date.now() - currentState.frameStats.lastFrameTime
              const frameDiff = currentFrames - currentState.frameStats.totalFrames
              const fps = frameDiff / (timeDiff / 1000)

              if (fps < 25 && timeDiff > 1000) {
                console.warn(`[mix ffmpeg] Low FPS detected: ${fps.toFixed(1)} fps over ${timeDiff}ms`)
              }
            }
            currentState.frameStats.totalFrames = currentFrames
            currentState.frameStats.lastFrameTime = Date.now()
          }
        }
      }
    }, 1000)

    // Store monitor interval for cleanup
    state.monitorInterval = monitorInterval

    // Emit recording starting event
    if (this.socket) {
      this.socket.emit('recordingStateChanged', {
        recording_id: recordingId,
        state: 'starting',
        timestamp: Date.now()
      })
    }

    // Wait for FFmpeg to start processing and then emit recording started
    let ffmpegReady = false
    const checkFFmpegReady = () => {
      const currentState = this.active.get(recordingId)
      if (!ffmpegReady && currentState && currentState.ff && currentState.ff.pid) {
        // Check if FFmpeg has actually started processing frames
        if (hasStarted || ffmpegLogs.some((log) => log.includes('frame='))) {
          ffmpegReady = true
          currentState.ffmpegStartedAt = Date.now()

          if (this.socket) {
            this.socket.emit('recordingStarted', {
              recording_id: recordingId,
              room_id: room_id,
              user_name: user_name,
              timestamp: Date.now(),
              ffmpeg_pid: currentState.ff.pid,
              frame_processing: true
            })
          }
        }
      }
    }

    // Check every 100ms for FFmpeg readiness
    const ffmpegCheckInterval = setInterval(() => {
      checkFFmpegReady()
      if (ffmpegReady) {
        clearInterval(ffmpegCheckInterval)
      }
    }, 100)

    // Fallback: emit after 3 seconds if FFmpeg doesn't start processing frames
    setTimeout(() => {
      const currentState = this.active.get(recordingId)
      if (!ffmpegReady && currentState && currentState.ff && currentState.ff.pid) {
        clearInterval(ffmpegCheckInterval)
        ffmpegReady = true
        currentState.ffmpegStartedAt = Date.now()

        console.warn('[mix ffmpeg] Using fallback timing - FFmpeg may not be processing frames properly')

        if (this.socket) {
          this.socket.emit('recordingStarted', {
            recording_id: recordingId,
            room_id: room_id,
            user_name: user_name,
            timestamp: Date.now(),
            fallback: true,
            warning: 'FFmpeg frame processing not detected'
          })
        }
      }
    }, 3000)

    return { success: true, recording_id: recordingId, file_name: fileName, file_path: outputPath }
  }

  async stopMixedRecording({ recording_id }) {
    const st = this.active.get(recording_id)
    if (!st) return { success: false, error: 'Not found' }

    // Emit recording stopping event
    if (this.socket) {
      this.socket.emit('recordingStateChanged', {
        recording_id: recording_id,
        state: 'stopping',
        timestamp: Date.now()
      })
    }

    // Calculate actual recording duration based on FFmpeg start time
    const actualStartTime = st.ffmpegStartedAt || st.startedAt
    const actualElapsed = Date.now() - actualStartTime

    console.log(`[mix ffmpeg] Actual recording duration: ${Math.round(actualElapsed / 1000)}s`)
    console.log(`[mix ffmpeg] FFmpeg started at: ${st.ffmpegStartedAt ? 'Yes' : 'No'}`)

    // Ensure minimum recording time (but don't artificially extend if FFmpeg is working)
    const minRunMs = 5000 // Reduced from 20s to 5s for better responsiveness
    if (actualElapsed < minRunMs) {
      const remainingTime = minRunMs - actualElapsed
      console.log(`[mix ffmpeg] Waiting ${remainingTime}ms to meet minimum recording time`)
      await new Promise((r) => setTimeout(r, remainingTime))
    }

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

    // Clear monitor interval
    if (st.monitorInterval) {
      clearInterval(st.monitorInterval)
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

    // Log final statistics
    console.log(`[mix ffmpeg] Final stats for ${recording_id}:`, {
      totalFrames: st.frameStats?.totalFrames || 0,
      recordingDuration: Math.round(actualElapsed / 1000),
      ffmpegLogs: st.ffmpegLogs?.length || 0
    })

    // Check output file duration
    const checkDuration = () => {
      return new Promise((resolve) => {
        // First check if file exists and has size
        if (!fs.existsSync(st.outputPath)) {
          console.error(`[mix ffmpeg] Output file does not exist: ${st.outputPath}`)
          resolve(0)
          return
        }

        const stats = fs.statSync(st.outputPath)
        if (stats.size === 0) {
          console.error(`[mix ffmpeg] Output file is empty: ${st.outputPath}`)
          resolve(0)
          return
        }

        console.log(`[mix ffmpeg] Output file size: ${stats.size} bytes`)

        const probe = spawn(
          'ffprobe',
          ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', st.outputPath],
          { stdio: ['pipe', 'pipe', 'pipe'] }
        )
        let output = ''
        let errorOutput = ''

        probe.stdout.on('data', (data) => (output += data))
        probe.stderr.on('data', (data) => (errorOutput += data))

        probe.on('close', (code) => {
          if (code !== 0) {
            console.error(`[mix ffmpeg] ffprobe failed with code ${code}:`, errorOutput)
            resolve(0)
            return
          }

          try {
            const json = JSON.parse(output)
            const duration = parseFloat(json.format?.duration || 0)
            console.log(`[mix ffmpeg] Output duration: ${duration}s`)
            console.log(`[mix ffmpeg] Expected duration: ${Math.round(actualElapsed / 1000)}s`)
            resolve(duration)
          } catch (parseError) {
            console.error('[mix ffmpeg] Failed to parse ffprobe output:', parseError)
            console.error('[mix ffmpeg] Raw output:', output)
            resolve(0)
          }
        })

        probe.on('error', (err) => {
          console.error('[mix ffmpeg] ffprobe error:', err)
          resolve(0)
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

    // Emit recording processing event
    if (this.socket) {
      this.socket.emit('recordingStateChanged', {
        recording_id: recording_id,
        state: 'processing',
        timestamp: Date.now()
      })
    }

    // Emit recording stopped event with accurate timing info
    if (this.socket) {
      this.socket.emit('recordingStopped', {
        recording_id: recording_id,
        file_name: st.fileName,
        file_path: st.outputPath,
        duration: duration,
        expected_duration: Math.round(actualElapsed / 1000),
        actual_elapsed: Math.round(actualElapsed / 1000),
        timestamp: Date.now()
      })
    }

    return {
      success: true,
      file_name: st.fileName,
      file_path: st.outputPath,
      file_exists: exists,
      duration,
      expected_duration: Math.round(actualElapsed / 1000),
      actual_elapsed: Math.round(actualElapsed / 1000)
    }
  }
}

module.exports = MixedRecordingManager
