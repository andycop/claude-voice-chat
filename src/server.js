require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// Set up WebSocket server
const wss = new WebSocket.Server({ server });

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Store ongoing conversations
const conversations = new Map();

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('Client connected');
  
  // Generate a unique ID for this conversation
  const conversationId = Date.now().toString();
  let messageHistory = [];

  // Initialize Speechmatics connection
  let speechmaticsWs = null;
  
  ws.on('message', async (message) => {
    const data = JSON.parse(message);
    
    if (data.type === 'start') {
      // Initialize Speechmatics WebSocket connection
      const speechmaticsUrl = 'wss://eu2.rt.speechmatics.com/v2';
      speechmaticsWs = new WebSocket(speechmaticsUrl);
      
      speechmaticsWs.on('open', () => {
        console.log('Connected to Speechmatics');
        
        // Send configuration to Speechmatics
        const config = {
          type: 'RecognitionStart',
          message_id: `message_${Date.now()}`,
          audio_format: {
            type: 'raw',
            encoding: 'pcm_s16le',
            sample_rate: 16000
          },
          transcription_config: {
            language: 'en',
            operating_point: 'enhanced',
            enable_partials: true,
            max_delay: 2
          }
        };
        
        speechmaticsWs.send(JSON.stringify(config));
      });
      
      speechmaticsWs.on('message', async (speechmaticsMessage) => {
        const response = JSON.parse(speechmaticsMessage);
        
        if (response.type === 'AddTranscript' || response.type === 'AddPartialTranscript') {
          const transcript = response.metadata.transcript;
          console.log('Transcript:', transcript);
          
          // Send transcript to client
          ws.send(JSON.stringify({
            type: 'transcript',
            text: transcript,
            isFinal: response.type === 'AddTranscript'
          }));
          
          // If it's a final transcript, send to Claude
          if (response.type === 'AddTranscript' && transcript.trim().length > 0) {
            // Add user message to history
            messageHistory.push({
              role: 'user',
              content: transcript,
            });
            
            try {
              // Get response from Claude
              const claudeResponse = await anthropic.messages.create({
                model: 'claude-3-opus-20240229',
                max_tokens: 1000,
                messages: [
                  {
                    role: 'system',
                    content: 'You are a helpful voice assistant. Respond concisely as you are part of a real-time conversation.'
                  },
                  ...messageHistory
                ],
              });
              
              const assistantMessage = claudeResponse.content[0].text;
              console.log('Claude response:', assistantMessage);
              
              // Add assistant message to history
              messageHistory.push({
                role: 'assistant',
                content: assistantMessage,
              });
              
              // Send Claude's response to client
              ws.send(JSON.stringify({
                type: 'response',
                text: assistantMessage
              }));
            } catch (error) {
              console.error('Error getting response from Claude:', error);
              ws.send(JSON.stringify({
                type: 'error',
                text: 'Error getting AI response'
              }));
            }
          }
        }
      });
      
      speechmaticsWs.on('error', (error) => {
        console.error('Speechmatics WebSocket error:', error);
        ws.send(JSON.stringify({
          type: 'error',
          text: 'Speech recognition error'
        }));
      });
      
      speechmaticsWs.on('close', () => {
        console.log('Disconnected from Speechmatics');
      });
    } else if (data.type === 'audio') {
      // Forward audio data to Speechmatics
      if (speechmaticsWs && speechmaticsWs.readyState === WebSocket.OPEN) {
        const audioData = {
          type: 'AddAudio',
          audio_data: data.audio
        };
        speechmaticsWs.send(JSON.stringify(audioData));
      }
    } else if (data.type === 'stop') {
      // Close Speechmatics connection
      if (speechmaticsWs) {
        const endMessage = {
          type: 'EndOfStream'
        };
        speechmaticsWs.send(JSON.stringify(endMessage));
      }
    }
  });
  
  ws.on('close', () => {
    console.log('Client disconnected');
    // Close Speechmatics connection if open
    if (speechmaticsWs && speechmaticsWs.readyState === WebSocket.OPEN) {
      speechmaticsWs.close();
    }
    // Clean up conversation history
    conversations.delete(conversationId);
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});