class RecordingManager {
  constructor(socket, roomClient) {
    this.socket = socket
    this.roomClient = roomClient
    this.isRecording = false
    this.recordingId = null
    this.recordingTimer = null
    this.recordingStartTime = null
    this.recordingEndTime = null

    this.isMixedRecording = false
    this.mixedRecordingId = null
    this.mixedTimer = null
    this.mixedRecordingStartTime = null
    this.mixedRecordingEndTime = null

    this.bindEvents()

    // Set up periodic health check
    this.healthCheckInterval = setInterval(() => {
      this.checkRecordingHealth()
    }, 30000) // Check every 30 seconds
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

    // Add new events for better synchronization
    this.socket.on('recordingStateChanged', (data) => {
      this.handleRecordingStateChanged(data)
    })
  }

  async startRecording() {
    try {
      const btn = document.getElementById('startRecordingButton')
      btn.disabled = true
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting...'

      // Default to mixed recording under the hood
      const response = await this.socket.request('startMixedRecording', {
        room_id: this.roomClient.room_id,
        user_name: this.roomClient.name
      })

      if (response.success) {
        this.recordingId = response.recording_id
        // Don't start timer immediately - wait for server confirmation
        this.updateUI(true)
        this.showSuccess('Recording request sent, starting...')
        console.log('Recording request sent (mixed):', response)

        // Fallback: if no server events received within 3 seconds, start timer anyway
        setTimeout(() => {
          if (!this.isRecording && this.recordingId) {
            console.log('Fallback: Starting recording timer (no server events received)')
            this.isRecording = true
            this.recordingStartTime = Date.now()
            this.startRecordingTimer()
            this.showSuccess('Recording started (fallback mode)')
          }
        }, 3000)
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

      // Default to stopping mixed recording
      const response = await this.socket.request('stopMixedRecording', {
        recording_id: this.recordingId
      })

      if (response.success) {
        // Don't stop timer immediately - wait for server confirmation
        this.showSuccess('Recording stop request sent, processing...')
        console.log('Recording stop request sent (mixed):', response)

        // Fallback: if no server events received within 5 seconds, stop timer anyway
        setTimeout(() => {
          if (this.isRecording && this.recordingId) {
            console.log('Fallback: Stopping recording timer (no server events received)')
            this.isRecording = false
            this.recordingEndTime = Date.now()
            this.stopRecordingTimer()

            if (this.recordingStartTime && this.recordingEndTime) {
              const actualDuration = Math.round((this.recordingEndTime - this.recordingStartTime) / 1000)
              this.showSuccess(`Recording completed (fallback mode)! Duration: ${actualDuration} seconds`)
            } else {
              this.showSuccess('Recording completed (fallback mode)!')
            }

            this.updateUI(false)
          }
        }, 5000)
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

  // Mixed helpers remain (not used by UI now)
  async startMixedRecording() {
    try {
      const btn = document.getElementById('startMixedRecordingButton')
      btn && (btn.disabled = true)
      if (btn) btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting...'

      const response = await this.socket.request('startMixedRecording', {
        room_id: this.roomClient.room_id,
        user_name: this.roomClient.name
      })

      if (response.success) {
        this.mixedRecordingId = response.recording_id
        // Don't start timer immediately - wait for server confirmation
        this.updateMixedUI(true)
        this.showSuccess('Mixed recording request sent, starting...')
        console.log('Mixed recording request sent:', response)
      } else {
        throw new Error(response.error || 'Failed to start mixed recording')
      }
    } catch (error) {
      console.error('Start mixed recording error:', error)
      this.showError(error.message || 'Unknown error occurred')
    } finally {
      const btn = document.getElementById('startMixedRecordingButton')
      if (btn) {
        btn.disabled = false
        btn.innerHTML = '<i class="fas fa-th-large"></i> Start Mixed Recording'
      }
    }
  }

  async stopMixedRecording() {
    try {
      const btn = document.getElementById('stopMixedRecordingButton')
      if (btn) btn.disabled = true

      const response = await this.socket.request('stopMixedRecording', {
        recording_id: this.mixedRecordingId
      })

      if (response.success) {
        // Don't stop timer immediately - wait for server confirmation
        this.showSuccess('Mixed recording stop request sent, processing...')
        console.log('Mixed recording stop request sent:', response)
      } else {
        throw new Error(response.error || 'Failed to stop mixed recording')
      }
    } catch (error) {
      console.error('Stop mixed recording error:', error)
      this.showError(error.message || 'Unknown error occurred')
    } finally {
      const btn = document.getElementById('stopMixedRecordingButton')
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

  updateMixedUI(isRecording) {
    const startBtn = document.getElementById('startMixedRecordingButton')
    const stopBtn = document.getElementById('stopMixedRecordingButton')

    if (isRecording) {
      if (startBtn) startBtn.classList.add('hidden')
      if (stopBtn) stopBtn.classList.remove('hidden')
    } else {
      if (startBtn) startBtn.classList.remove('hidden')
      if (stopBtn) stopBtn.classList.add('hidden')
    }
  }

  startRecordingTimer() {
    if (this.recordingTimer) {
      clearInterval(this.recordingTimer)
    }

    this.recordingTimer = setInterval(() => {
      if (!this.isRecording || !this.recordingStartTime) {
        clearInterval(this.recordingTimer)
        return
      }

      const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000)
      const minutes = Math.floor(elapsed / 60)
      const secs = elapsed % 60
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

  startMixedTimer() {
    if (this.mixedTimer) {
      clearInterval(this.mixedTimer)
    }

    this.mixedTimer = setInterval(() => {
      if (!this.isMixedRecording || !this.mixedRecordingStartTime) {
        clearInterval(this.mixedTimer)
        return
      }

      const elapsed = Math.floor((Date.now() - this.mixedRecordingStartTime) / 1000)
      const minutes = Math.floor(elapsed / 60)
      const secs = elapsed % 60
      const timeText = `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`

      const stopBtn = document.getElementById('stopMixedRecordingButton')
      if (stopBtn) {
        stopBtn.innerHTML = `<i class="fas fa-stop"></i> Mixed ${timeText}`
      }
    }, 1000)
  }

  stopMixedTimer() {
    if (this.mixedTimer) {
      clearInterval(this.mixedTimer)
      this.mixedTimer = null
    }

    const stopBtn = document.getElementById('stopMixedRecordingButton')
    if (stopBtn) {
      stopBtn.innerHTML = '<i class="fas fa-stop"></i> Stop Mixed Recording'
    }
  }

  handleRecordingStarted(data) {
    console.log('Recording started:', data)

    // Only start timer when server confirms recording has actually started
    if (data.recording_id === this.recordingId || data.recording_id === this.mixedRecordingId) {
      if (data.recording_id === this.recordingId) {
        this.isRecording = true
        this.recordingStartTime = Date.now()
        this.startRecordingTimer()
        this.showSuccess('Recording is now active!')
      } else if (data.recording_id === this.mixedRecordingId) {
        this.isMixedRecording = true
        this.mixedRecordingStartTime = Date.now()
        this.startMixedTimer()
        this.showSuccess('Mixed recording is now active!')
      }
    }
  }

  handleRecordingStopped(data) {
    console.log('Recording stopped:', data)

    // Only stop timer when server confirms recording has actually stopped
    if (data.recording_id === this.recordingId || data.recording_id === this.mixedRecordingId) {
      if (data.recording_id === this.recordingId) {
        this.isRecording = false
        this.recordingEndTime = Date.now()
        this.stopRecordingTimer()

        // Calculate actual recording duration
        if (this.recordingStartTime && this.recordingEndTime) {
          const actualDuration = Math.round((this.recordingEndTime - this.recordingStartTime) / 1000)
          this.showSuccess(`Recording completed! Duration: ${actualDuration} seconds`)
        } else {
          this.showSuccess('Recording completed!')
        }

        this.updateUI(false)
      } else if (data.recording_id === this.mixedRecordingId) {
        this.isMixedRecording = false
        this.mixedRecordingEndTime = Date.now()
        this.stopMixedTimer()

        // Calculate actual mixed recording duration
        if (this.mixedRecordingStartTime && this.mixedRecordingEndTime) {
          const actualDuration = Math.round((this.mixedRecordingEndTime - this.mixedRecordingStartTime) / 1000)
          this.showSuccess(`Mixed recording completed! Duration: ${actualDuration} seconds`)
        } else {
          this.showSuccess('Mixed recording completed!')
        }

        this.updateMixedUI(false)
      }
    }
  }

  handleRecordingStateChanged(data) {
    console.log('Recording state changed:', data)

    // Handle intermediate state changes from server
    if (data.recording_id === this.recordingId || data.recording_id === this.mixedRecordingId) {
      if (data.state === 'starting') {
        this.showSuccess('Recording is starting on server...')
      } else if (data.state === 'stopping') {
        this.showSuccess('Recording is stopping on server...')
      } else if (data.state === 'processing') {
        this.showSuccess('Recording is being processed...')
      }
    }
  }

  handleRecordingError(error) {
    console.error('Recording error:', error)

    // Reset state on error
    this.resetRecordingState()

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

  // Cleanup method to be called when component unmounts
  cleanup() {
    this.resetRecordingState()

    // Clear health check interval
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
    }

    // Remove event listeners
    if (this.socket) {
      this.socket.off('recordingStarted')
      this.socket.off('recordingStopped')
      this.socket.off('recordingError')
      this.socket.off('recordingStateChanged')
    }
  }

  resetRecordingState() {
    this.isRecording = false
    this.recordingId = null
    this.recordingStartTime = null
    this.recordingEndTime = null
    this.stopRecordingTimer()

    this.isMixedRecording = false
    this.mixedRecordingId = null
    this.mixedRecordingStartTime = null
    this.mixedRecordingEndTime = null
    this.stopMixedTimer()

    this.updateUI(false)
    this.updateMixedUI(false)
  }

  // Method to get current recording duration
  getCurrentRecordingDuration() {
    if (!this.isRecording || !this.recordingStartTime) {
      return 0
    }
    return Math.floor((Date.now() - this.recordingStartTime) / 1000)
  }

  // Method to get current mixed recording duration
  getCurrentMixedRecordingDuration() {
    if (!this.isMixedRecording || !this.mixedRecordingStartTime) {
      return 0
    }
    return Math.floor((Date.now() - this.mixedRecordingStartTime) / 1000)
  }

  // Method to handle recording timeouts
  handleRecordingTimeout() {
    if (this.isRecording) {
      console.warn('Recording timeout detected, cleaning up...')
      this.resetRecordingState()
      this.showError('Recording timeout - please try again')
    }
  }

  // Method to check recording health
  checkRecordingHealth() {
    if (this.isRecording && this.recordingStartTime) {
      const elapsed = Date.now() - this.recordingStartTime
      // If recording has been running for more than 2 hours, consider it stale
      if (elapsed > 2 * 60 * 60 * 1000) {
        console.warn('Recording appears to be stale, cleaning up...')
        this.resetRecordingState()
        this.showError('Recording appears to be stale - please restart')
      }
    }
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

function startMixedRecording() {
  if (recordingManager) {
    recordingManager.startMixedRecording()
  } else {
    console.error('RecordingManager not initialized')
  }
}

function stopMixedRecording() {
  if (recordingManager) {
    recordingManager.stopMixedRecording()
  } else {
    console.error('RecordingManager not initialized')
  }
}

// Initialize recording when RoomClient is ready
function initRecording(socket, roomClient) {
  recordingManager = new RecordingManager(socket, roomClient)
}
