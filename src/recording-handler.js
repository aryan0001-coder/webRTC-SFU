const RecordingManager = require('./recording/recording-manager')

class RecordingHandler {
  constructor(room, socket) {
    this.room = room
    this.socket = socket
    this.recordingManager = new RecordingManager(room, socket)
  }

  async startRecording(data) {
    try {
      const { room_id, user_name } = data

      // Wait for router to be ready
      let router
      if (this.room.waitForRouter) {
        router = await this.room.waitForRouter()
      } else {
        router = this.room.router
      }

      if (!router) {
        throw new Error('Room router not initialized')
      }

      // Ensure router has required methods
      if (!router.rtpCapabilities || !router.rtpCapabilities.codecs) {
        throw new Error('Router RTP capabilities not available')
      }

      const response = await this.recordingManager.startRecording(data)
      return response
    } catch (error) {
      console.error('Start recording error:', error)
      return {
        success: false,
        error: error.message
      }
    }
  }

  async stopRecording(data) {
    try {
      const { recording_id } = data

      const response = await this.recordingManager.stopRecording(data)
      return response
    } catch (error) {
      console.error('Stop recording error:', error)
      return {
        success: false,
        error: error.message
      }
    }
  }
}

module.exports = RecordingHandler
