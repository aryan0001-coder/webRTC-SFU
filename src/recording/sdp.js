const { getCodecInfoFromRtpParameters } = require('./utils')

module.exports.createSdpText = (rtpParameters) => {
  const { videoCodec, audioCodec, remoteRtpPort, remoteAudioRtpPort } = rtpParameters

  const sdpLines = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=FFmpeg', 'c=IN IP4 127.0.0.1', 't=0 0']

  if (videoCodec && videoCodec.codecs && Array.isArray(videoCodec.codecs) && videoCodec.codecs.length > 0) {
    const videoInfo = getCodecInfoFromRtpParameters('video', videoCodec)
    const videoCodecInfo = videoCodec.codecs[0]

    sdpLines.push(
      `m=video ${remoteRtpPort} RTP/AVP ${videoInfo.payloadType}`,
      `a=rtpmap:${videoInfo.payloadType} ${videoInfo.codecName}/${videoInfo.clockRate}`,
      'a=recvonly'
    )

    // Add fmtp line if present
    if (videoCodecInfo.parameters) {
      const fmtpParams = Object.entries(videoCodecInfo.parameters)
        .map(([key, value]) => `${key}=${value}`)
        .join(';')
      sdpLines.push(`a=fmtp:${videoInfo.payloadType} ${fmtpParams}`)
    }
  }

  if (audioCodec && audioCodec.codecs && Array.isArray(audioCodec.codecs) && audioCodec.codecs.length > 0) {
    const audioInfo = getCodecInfoFromRtpParameters('audio', audioCodec)
    const audioCodecInfo = audioCodec.codecs[0]

    const audioPort = remoteAudioRtpPort || remoteRtpPort + 2

    sdpLines.push(
      `m=audio ${audioPort} RTP/AVP ${audioInfo.payloadType}`,
      `a=rtpmap:${audioInfo.payloadType} ${audioInfo.codecName}/${audioInfo.clockRate}/${audioInfo.channels || 2}`,
      'a=recvonly'
    )

    // Add fmtp line if present
    if (audioCodecInfo.parameters) {
      const fmtpParams = Object.entries(audioCodecInfo.parameters)
        .map(([key, value]) => `${key}=${value}`)
        .join(';')
      sdpLines.push(`a=fmtp:${audioInfo.payloadType} ${fmtpParams}`)
    }
  }

  return sdpLines.join('\n') + '\n'
}
