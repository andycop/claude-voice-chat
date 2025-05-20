# Claude Voice Chat

A real-time voice chat application using Speechmatics for speech recognition and Claude AI for generating responses.

## Features

- Real-time speech recognition using Speechmatics API
- Intelligent responses from Claude AI
- Simple and intuitive web interface
- WebSocket-based real-time communication

## Prerequisites

- Node.js (v14 or later)
- npm (v6 or later)
- Speechmatics API key
- Claude API key (Anthropic)

## Installation

1. Clone the repository
   ```
   git clone <repository-url>
   cd claude-voice-chat
   ```

2. Install dependencies
   ```
   npm install
   ```

3. Create a `.env` file in the root directory with the following content:
   ```
   SPEECHMATICS_API_KEY=your_speechmatics_api_key_here
   ANTHROPIC_API_KEY=your_anthropic_api_key_here
   PORT=3000
   ```

## Usage

1. Start the server
   ```
   npm start
   ```
   For development with auto-restart:
   ```
   npm run dev
   ```

2. Open your web browser and navigate to `http://localhost:3000`

3. Click the "Start Listening" button and begin speaking

4. The application will transcribe your speech in real-time and show Claude's responses

## Architecture

### Backend

- Node.js with Express
- WebSocket server for real-time communication
- Integration with Speechmatics and Claude APIs

### Frontend

- HTML/CSS/JavaScript
- Web Audio API for audio capture
- WebSocket client for real-time communication

## Future Enhancements

- Text-to-Speech functionality to give Claude a voice
- Note-taking and task list creation from meeting content
- Real-time information retrieval during meetings

## License

ISC