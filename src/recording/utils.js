const { Readable } = require('stream')

module.exports.convertStringToStream = (stringToConvert) => {
  const stream = new Readable()
  stream._read = () => {}
  stream.push(stringToConvert)
  stream.push(null)
  return stream
}

module.exports.getCodecInfoFromRtpParameters = (kind, rtpParameters) => {
  if (
    !rtpParameters ||
    !rtpParameters.codecs ||
    !Array.isArray(rtpParameters.codecs) ||
    rtpParameters.codecs.length === 0
  ) {
    console.error('Invalid rtpParameters:', rtpParameters)
    throw new Error(`No codecs found for ${kind} in rtpParameters`)
  }

  const codec = rtpParameters.codecs[0]
  return {
    payloadType: codec.payloadType,
    codecName: codec.mimeType.replace(`${kind}/`, ''),
    clockRate: codec.clockRate,
    channels: kind === 'audio' ? codec.channels : undefined
  }
}

module.exports.validateRtpParameters = (rtpParameters) => {
  if (!rtpParameters) {
    throw new Error('RTP parameters are required')
  }

  if (!rtpParameters.codecs || !Array.isArray(rtpParameters.codecs)) {
    throw new Error('Invalid codecs in RTP parameters')
  }

  if (rtpParameters.codecs.length === 0) {
    throw new Error('No codecs found in RTP parameters')
  }

  // Validate each codec
  for (const codec of rtpParameters.codecs) {
    if (!codec.mimeType || !codec.payloadType || !codec.clockRate) {
      throw new Error(`Invalid codec: ${JSON.stringify(codec)}`)
    }
  }

  return true
}

module.exports.formatRtpParametersForFFmpeg = (rtpParameters) => {
  if (!rtpParameters || !rtpParameters.codecs || rtpParameters.codecs.length === 0) {
    throw new Error('Invalid RTP parameters for FFmpeg')
  }

  const videoCodec = rtpParameters.codecs.find((c) => c.mimeType.includes('video'))
  const audioCodec = rtpParameters.codecs.find((c) => c.mimeType.includes('audio'))

  return {
    videoCodec: videoCodec || null,
    audioCodec: audioCodec || null
  }
}
