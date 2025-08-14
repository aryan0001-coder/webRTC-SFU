const fs = require('fs')
const path = require('path')
const dgram = require('dgram')
const { getSupportedRtpCapabilities } = require('mediasoup')
const { spawn } = require('child_process')

class PerParticipantRecorder {
  constructor(room) {
    this.room = room
    this.active = new Map() // recordingId -> state
  }

  async _getFreePort() {
    async function isPortFree(port) {
      return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4')
        sock.once('error', () => {
          try { sock.close() } catch {}
          resolve(false)
        })
        sock.bind({ port, address: '127.0.0.1', exclusive: true }, () => {
          try { sock.close() } catch {}
          resolve(true)
        })
      })
    }
    for (let i = 0; i < 200; i += 1) {
      const candidate = 20000 + Math.floor(Math.random() * 40000)
      if (await isPortFree(candidate)) return candidate
    }
    throw new Error('No free UDP port available')
  }

  _sdpFor(kind, payloadType, codecName, clockRate, port, channels, fmtp) {
    const lines = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=FFmpegInput', 'c=IN IP4 127.0.0.1', 't=0 0']
    if (kind === 'video') {
      lines.push(
        `m=video ${port} RTP/AVP ${payloadType}`,
        `a=rtpmap:${payloadType} ${codecName}/${clockRate}`,
        'a=recvonly'
      )
      if (fmtp) lines.push(`a=fmtp:${payloadType} ${fmtp}`)
    } else {
      lines.push(
        `m=audio ${port} RTP/AVP ${payloadType}`,
        `a=rtpmap:${payloadType} ${codecName}/${clockRate}/${channels || 2}`,
        'a=recvonly'
      )
      if (fmtp) lines.push(`a=fmtp:${payloadType} ${fmtp}`)
    }
    return lines.join('\n') + '\n'
  }

  _codecInfo(kind, rtpParameters) {
    if (!rtpParameters || !Array.isArray(rtpParameters.codecs)) return null
    const c = rtpParameters.codecs.find((x) => x.mimeType.toLowerCase().includes(kind))
    if (!c) return null
    const fmtp = c.parameters && Object.keys(c.parameters).length
      ? Object.entries(c.parameters).map(([k, v]) => `${k}=${v}`).join(';')
      : ''
    return {
      payloadType: c.payloadType,
      codecName: c.mimeType.split('/')[1],
      clockRate: c.clockRate,
      channels: kind === 'audio' ? c.channels || 2 : undefined,
      fmtp
    }
  }

  async start(roomId) {
    const router = this.room?.router
    if (!router) throw new Error('Router not initialized')

    const recorderRtpCapabilities = getSupportedRtpCapabilities()

    const peers = this.room.getPeers()
    const producers = []
    for (const [, peer] of peers) {
      for (const [, producer] of peer.producers) {
        if (producer.kind === 'video' || producer.kind === 'audio') producers.push({ peerId: peer.id, producer })
      }
    }

    if (producers.length === 0) throw new Error('No producers to record')

    const recordingId = `rec-per-${Date.now()}`
    const outDir = process.env.RECORD_FILE_LOCATION_PATH || './files'
    const baseDir = path.join(outDir, 'per', roomId, recordingId)
    fs.mkdirSync(baseDir, { recursive: true })

    const items = [] // per-producer state

    for (const { peerId, producer } of producers) {
      if (!router.canConsume({ producerId: producer.id, rtpCapabilities: recorderRtpCapabilities })) continue

      const transport = await router.createPlainTransport({ listenIp: '127.0.0.1', rtcpMux: false, comedia: false })
      const consumer = await transport.consume({ producerId: producer.id, rtpCapabilities: recorderRtpCapabilities, paused: true })

      const ci = this._codecInfo(producer.kind, consumer.rtpParameters)
      const port = await this._getFreePort()
      await transport.connect({ ip: '127.0.0.1', port, rtcpPort: port + 1 })

      const sdpPath = path.join(baseDir, `${producer.kind}-${peerId}-${producer.id}.sdp`)
      fs.writeFileSync(sdpPath, this._sdpFor(producer.kind, ci.payloadType, ci.codecName, ci.clockRate, port, ci.channels, ci.fmtp))

      const outFile = path.join(baseDir, `${producer.kind}-${peerId}-${producer.id}.webm`)

      // Build ffmpeg for this single input
      const ffArgs = [
        '-nostdin', '-y', '-loglevel', 'info', '-protocol_whitelist', 'file,udp,rtp',
        '-fflags', '+genpts', '-analyzeduration', '10000000', '-probesize', '10000000',
        '-f', 'sdp', '-i', sdpPath
      ]
      if (producer.kind === 'video') {
        ffArgs.push('-map', '0:v:0')
      } else {
        ffArgs.push('-map', '0:a:0')
      }
      // Re-encode to ensure robust output
      if (producer.kind === 'video') {
        ffArgs.push('-c:v', 'libvpx', '-b:v', '2000k', '-crf', '32', '-r', '30', '-pix_fmt', 'yuv420p')
      } else {
        ffArgs.push('-c:a', 'libopus', '-b:a', '128k')
      }
      ffArgs.push(outFile)

      const ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
      ff.stderr.setEncoding('utf-8')
      ff.stderr.on('data', (d) => console.log('[per ffmpeg]', d.trim()))
      ff.on('close', () => console.log('[per ffmpeg] closed', outFile))

      try { await consumer.resume() } catch {}
      if (producer.kind === 'video') { try { await consumer.requestKeyFrame() } catch {} }

      items.push({ peerId, producerId: producer.id, kind: producer.kind, transport, consumer, sdpPath, outFile, ff })
    }

    const state = {
      id: recordingId,
      roomId,
      baseDir,
      startedAt: Date.now(),
      items
    }
    this.active.set(recordingId, state)
    return recordingId
  }

  get(recordingId) {
    return this.active.get(recordingId) || null
  }

  async stop(recordingId) {
    const st = this.active.get(recordingId)
    if (!st) throw new Error('Recording not found')

    for (const it of st.items) {
      try { it.ff.kill('SIGINT') } catch {}
      try { await it.consumer.close() } catch {}
      try { await it.transport.close() } catch {}
    }

    const endedAt = Date.now()
    const files = st.items.map((it) => it.outFile)
    const metadata = {
      id: st.id,
      roomId: st.roomId,
      startedAt: st.startedAt,
      endedAt,
      durationMs: endedAt - st.startedAt,
      files
    }
    try {
      fs.writeFileSync(path.join(st.baseDir, 'metadata.json'), JSON.stringify(metadata, null, 2))
    } catch {}

    this.active.delete(recordingId)
    return metadata
  }
}

module.exports = PerParticipantRecorder