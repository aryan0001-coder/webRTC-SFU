# 🎥 WebRTC Based Video Calling System

A modern, secure, and lightweight video conferencing solution built with WebRTC and Mediasoup. This system provides high-quality video/audio communication for teams, classrooms, and social gatherings with enterprise-grade security.

## ✨ Features

- **Crystal Clear Video & Audio**: HD video with adaptive bitrate and noise cancellation
- **Screen Sharing**: Share your entire screen or specific applications
- **Multiple Rooms**: Create unlimited private meeting rooms
- **Mobile Responsive**: Works seamlessly on all devices and browsers
- **End-to-End Security**: SSL/TLS encryption with secure room access
- **Easy Deployment**: Docker support for quick setup and scaling

## 🚀 Quick Start

### Prerequisites
- Node.js 16+ and npm
- SSL certificates (self-signed or Let's Encrypt)
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

# Access at https://localhost:3016
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

1. Open your browser to `https://localhost:3016`
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

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📞 Support

For support, please open an issue on GitHub or contact the project maintainer.
