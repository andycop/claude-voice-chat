# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Voice Chat is a real-time voice chat application that uses the Speechmatics API for speech recognition and the Claude AI API for generating responses. The application allows users to speak into their microphone, have their speech transcribed in real-time, and receive responses from Claude with markdown formatting support.

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

If a `.env` file is not found, the application will automatically create one using the template from `.env.example`. You will need to edit this file and add your API keys before the application can function properly.

## Project Structure

- `/src` - Server-side code
  - `server.js` - Main server file with WebSocket handling and API integrations
- `/public` - Client-side code
  - `index.html` - Frontend UI structure
  - `app.js` - Frontend logic and WebSocket client
  - `audio-processor.js` - Audio processing with Web Audio API
  - `styles.css` - UI styling
- `/logs` - Server logs (created automatically)
- `/recordings` - Saved audio recordings (created automatically)

## Architecture

### Backend

- Node.js server using Express
- WebSocket connections for real-time communication
- Integration with Speechmatics API for real-time speech recognition
- Integration with Claude API for AI responses
- Audio recording functionality to save conversations

### Frontend

- Simple HTML/CSS/JavaScript frontend
- Web Audio API for audio capture and processing
- WebSocket client for real-time communication with the server
- Audio visualization for microphone input
- AudioWorklet for efficient audio processing with fallback to ScriptProcessor
- Microphone selection dropdown for choosing input device
- Markdown rendering for Claude's responses using marked.js

### Data Flow

1. User speaks into their microphone
2. Audio is captured in the browser and sent to the server via WebSocket
3. Server forwards audio to Speechmatics API for real-time transcription
4. Transcribed text is sent back to the client and displayed
5. Final transcriptions are sent to Claude API for processing
6. Claude's responses are sent back to the client and displayed with markdown formatting

### Logging System

The application includes a comprehensive logging system:
- Server logs in `logs/server.log`
- Error logs in `logs/error.log`
- Different log levels (debug, info, warn, error)
- Flow-level logging for API communications

### Speech Recognition Features

- Real-time transcription using Speechmatics API
- Support for both partial and final transcripts
- Silence detection for determining when to send transcripts
- Audio recording capability for saving conversations to WAV files

## Key Implementation Details

### Audio Processing
- Audio is captured at the browser's native sample rate and resampled to 16kHz for Speechmatics
- Uses AudioWorklet with fallback to ScriptProcessor for browsers without AudioWorklet support
- PCM audio is converted to WAV format for recordings

### Transcript Handling
- Accumulates transcripts with timestamp information
- Handles both partial (in-progress) and final transcripts
- Uses silence detection (either time-based or empty transcript detection) to determine when to process full sentences

### Error Handling and Recovery
- Detects and reports API key validation issues
- Handles Speechmatics API failures with automatic retry mechanisms
- Manages concurrent session limitations in Speechmatics

### UI Features
- Real-time status indicators for connection, speech detection, API processing, and Claude's status
- Audio visualization for microphone input
- Markdown rendering for Claude's responses
- Download links for recorded conversations

## Important Files

- `src/server.js` - Main server file with WebSocket handling and API integrations
- `public/index.html` - Frontend UI structure
- `public/app.js` - Frontend logic and WebSocket client
- `public/audio-processor.js` - Audio processing with Web Audio API
- `public/styles.css` - UI styling

## Future Enhancements

- Integration with a Text-to-Speech API to give Claude a voice
- Capturing notes and task lists from meetings
- Providing information in real-time during meetings