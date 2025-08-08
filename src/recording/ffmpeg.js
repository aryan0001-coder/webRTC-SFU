// FFmpeg process handler from mediasoup3-record-demo
const child_process = require('child_process')
const { EventEmitter } = require('events')
const { createSdpText } = require('./sdp')
const { convertStringToStream } = require('./utils')

const RECORD_FILE_LOCATION_PATH = process.env.RECORD_FILE_LOCATION_PATH || './files'

module.exports = class FFmpeg {
  constructor(rtpParameters) {
    this._rtpParameters = rtpParameters
    this._process = undefined
    this._observer = new EventEmitter()
    this._createProcess()
  }

  _createProcess() {
    const sdpString = createSdpText(this._rtpParameters)
    const sdpStream = convertStringToStream(sdpString)

    console.log('createProcess() [sdpString:%s]', sdpString)

    this._process = child_process.spawn('ffmpeg', this._commandArgs)

    if (this._process.stderr) {
      this._process.stderr.setEncoding('utf-8')
      this._process.stderr.on('data', (data) => {
        console.log('ffmpeg::process::data [data:%o]', data)
      })
    }

    if (this._process.stdout) {
      this._process.stdout.setEncoding('utf-8')
      this._process.stdout.on('data', (data) => {
        console.log('ffmpeg::process::data [data:%o]', data)
      })
    }

    this._process.on('close', (code) => {
      console.log('ffmpeg::process::close [code:%s]', code)
    })

    this._process.on('exit', (code) => {
      console.log('ffmpeg::process::exit [code:%s]', code)
    })

    this._process.on('error', (error) => {
      console.error('ffmpeg::process::error [error:%o]', error)
    })

    this._process.stdin.on('error', (error) => {
      console.error('ffmpeg::stdin::error [error:%o]', error)
    })

    this._process.stdout.on('error', (error) => {
      console.error('ffmpeg::stdout::error [error:%o]', error)
    })

    this._process.stderr.on('error', (error) => {
      console.error('ffmpeg::stderr::error [error:%o]', error)
    })

    // Pipe SDP stream to ffmpeg stdin
    sdpStream.pipe(this._process.stdin)
  }

  get _commandArgs() {
    const commandArgs = [
      '-loglevel',
      'debug',
      '-protocol_whitelist',
      'pipe,udp,rtp',
      '-fflags',
      '+genpts',
      '-f',
      'sdp',
      '-i',
      'pipe:0'
    ]

    // Add video codec parameters
    if (this._rtpParameters.videoCodec) {
      commandArgs.push('-map', '0:v:0', '-c:v', 'copy')
    }

    // Add audio codec parameters
    if (this._rtpParameters.audioCodec) {
      commandArgs.push('-map', '0:a:0', '-c:a', 'copy')
    }

    // Output file
    const fileName = `recording-${Date.now()}.mp4`
    commandArgs.push('-flags', '+global_header', `${RECORD_FILE_LOCATION_PATH}/${fileName}`)

    return commandArgs
  }

  get pid() {
    return this._process ? this._process.pid : undefined
  }

  kill() {
    console.log('kill() [pid:%s]', this.pid)

    if (this._process) {
      this._process.kill('SIGKILL')
    }
  }

  get observer() {
    return this._observer
  }
}
