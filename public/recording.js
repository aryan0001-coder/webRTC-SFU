// Frontend recording functionality
class RecordingManager {
  constructor(socket, roomClient) {
    this.socket = socket
    this.roomClient = roomClient
    this.isRecording = false
    this.recordingId = null
    this.recordingTimer = null

    this.bindEvents()
  }

  bindEvents() {
    // Socket events for recording
    this.socket.on('recordingStarted', (data) => {
      this.handleRecordingStarted(data)
    })

    this.socket.on('recordingStopped', (data) => {
      this.handleRecordingStopped(data)
    })

    this.socket.on('recordingError', (error) => {
      this.handleRecordingError(error)
    })
  }

  async startRecording() {
    try {
      const btn = document.getElementById('startRecordingButton')
      btn.disabled = true
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting...'

      const response = await this.socket.request('startRecording', {
        room_id: this.roomClient.room_id,
        user_name: this.roomClient.name
      })

      if (response.success) {
        this.recordingId = response.recording_id
        this.isRecording = true
        this.updateUI(true)
        this.startRecordingTimer()
        this.showSuccess('Recording started successfully')
        console.log('Recording started:', response)
      } else {
        throw new Error(response.error || 'Failed to start recording')
      }
    } catch (error) {
      console.error('Start recording error:', error)
      this.showError(error.message || 'Unknown error occurred')
    } finally {
      const btn = document.getElementById('startRecordingButton')
      if (btn) {
        btn.disabled = false
        btn.innerHTML = '<i class="fas fa-record-vinyl"></i> Start Recording'
      }
    }
  }

  async stopRecording() {
    try {
      const btn = document.getElementById('stopRecordingButton')
      if (btn) btn.disabled = true

      const response = await this.socket.request('stopRecording', {
        recording_id: this.recordingId
      })

      if (response.success) {
        this.isRecording = false
        this.updateUI(false)
        this.stopRecordingTimer()
        this.showSuccess(`Recording saved: ${response.file_name}`)
        console.log('Recording stopped:', response)
      } else {
        throw new Error(response.error || 'Failed to stop recording')
      }
    } catch (error) {
      console.error('Stop recording error:', error)
      this.showError(error.message || 'Unknown error occurred')
    } finally {
      const btn = document.getElementById('stopRecordingButton')
      if (btn) btn.disabled = false
    }
  }

  updateUI(isRecording) {
    const startBtn = document.getElementById('startRecordingButton')
    const stopBtn = document.getElementById('stopRecordingButton')

    if (isRecording) {
      if (startBtn) startBtn.classList.add('hidden')
      if (stopBtn) stopBtn.classList.remove('hidden')
    } else {
      if (startBtn) startBtn.classList.remove('hidden')
      if (stopBtn) stopBtn.classList.add('hidden')
    }
  }

  startRecordingTimer() {
    let seconds = 0
    this.recordingTimer = setInterval(() => {
      if (!this.isRecording) {
        clearInterval(this.recordingTimer)
        return
      }

      seconds++
      const minutes = Math.floor(seconds / 60)
      const secs = seconds % 60
      const timeText = `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`

      // Update button text to show recording time
      const stopBtn = document.getElementById('stopRecordingButton')
      if (stopBtn) {
        stopBtn.innerHTML = `<i class="fas fa-stop"></i> Recording ${timeText}`
      }
    }, 1000)
  }

  stopRecordingTimer() {
    if (this.recordingTimer) {
      clearInterval(this.recordingTimer)
      this.recordingTimer = null
    }

    // Reset button text
    const stopBtn = document.getElementById('stopRecordingButton')
    if (stopBtn) {
      stopBtn.innerHTML = '<i class="fas fa-stop"></i> Stop Recording'
    }
  }

  handleRecordingStarted(data) {
    console.log('Recording started:', data)
  }

  handleRecordingStopped(data) {
    console.log('Recording stopped:', data)
  }

  handleRecordingError(error) {
    console.error('Recording error:', error)
    this.showError(error.message || 'Unknown recording error')
  }

  showError(message) {
    console.error('Recording Error:', message)
    alert('Recording Error: ' + message)
  }

  showSuccess(message) {
    console.log('Recording Success:', message)
    alert('Recording Success: ' + message)
  }
}

// Global functions for HTML onclick handlers
let recordingManager = null

function startRecording() {
  if (recordingManager) {
    recordingManager.startRecording()
  } else {
    console.error('RecordingManager not initialized')
  }
}

function stopRecording() {
  if (recordingManager) {
    recordingManager.stopRecording()
  } else {
    console.error('RecordingManager not initialized')
  }
}

// Initialize recording when RoomClient is ready
function initRecording(socket, roomClient) {
  recordingManager = new RecordingManager(socket, roomClient)
}
