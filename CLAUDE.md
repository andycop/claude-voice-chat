# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Voice Chat is a real-time voice chat application that uses the Speechmatics API for speech recognition and the Claude AI API for generating responses. The application allows users to speak into their microphone, have their speech transcribed in real-time, and receive responses from Claude.

## Development Commands

- `npm install` - Install all dependencies
- `npm start` - Start the server
- `npm run dev` - Start the server with nodemon for development (auto-restart on file changes)

## Environment Variables

The application requires the following environment variables to be set in a `.env` file:

```
# Speechmatics API credentials
SPEECHMATICS_API_KEY=your_speechmatics_api_key_here

# Claude API key
ANTHROPIC_API_KEY=your_anthropic_api_key_here

# Server configuration
PORT=3000
```

## Architecture

### Backend

- Node.js server using Express
- WebSocket connections for real-time communication
- Integration with Speechmatics API for real-time speech recognition
- Integration with Claude API for AI responses

### Frontend

- Simple HTML/CSS/JavaScript frontend
- Web Audio API for audio capture and processing
- WebSocket client for real-time communication with the server

### Data Flow

1. User speaks into their microphone
2. Audio is captured in the browser and sent to the server via WebSocket
3. Server forwards audio to Speechmatics API for real-time transcription
4. Transcribed text is sent back to the client and displayed
5. Final transcriptions are sent to Claude API for processing
6. Claude's responses are sent back to the client and displayed

## Future Enhancements

- Integration with a Text-to-Speech API to give Claude a voice
- Capturing notes and task lists from meetings
- Providing information in real-time during meetings