# 🎥 WebRTC Based Video Calling System

A modern, secure, and lightweight video conferencing solution built with WebRTC and Mediasoup. This system provides high-quality video/audio communication for teams, classrooms, and social gatherings with enterprise-grade security.

## ✨ Features

- **Crystal Clear Video & Audio**: HD video with adaptive bitrate and noise cancellation
- **Screen Sharing**: Share your entire screen or specific applications
- **Multiple Rooms**: Create unlimited private meeting rooms
- **Mobile Responsive**: Works seamlessly on all devices and browsers
- **Easy Deployment**: Docker support for quick setup and scaling

## 🚀 Quick Start

### Prerequisites
- Node.js 16+ and npm
- Docker (optional, for containerized deployment)

### Installation
```bash
# Clone the repository
git clone [your-repo-url]
cd webrtc-video-calling-system

# Install dependencies
npm install

# Start the application
npm start

# Access at http://localhost:3016
```

### Docker Deployment
```bash
# Build and run with Docker
docker build -t webrtc-video-calling .
docker run -p 3016:3016 -p 10000-10100:10000-10100 webrtc-video-calling
```

## 🔧 Configuration

Edit `src/config.js` to customize:
- Server port and IP binding
- SSL certificate paths
- Media codec settings
- Transport configurations

## 📱 Usage

1. Open your browser to `http://localhost:3016`
2. Enter a room name and your display name
3. Share the room URL with participants
4. Enjoy secure video communication!

## 🛠️ Development

```bash
# Development mode with auto-reload
npm run mon

# Format code
npm run lint
```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.



