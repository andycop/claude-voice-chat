const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Check if .env file exists
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  console.log('.env file found at:', envPath);
  dotenv.config();
} else {
  console.warn('Warning: .env file not found at:', envPath);
  console.warn('Please create a .env file with your API keys (see .env.example)');
  // Create a default .env file with placeholders
  const envExample = fs.readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8');
  fs.writeFileSync(envPath, envExample, 'utf8');
  console.log('Created placeholder .env file. Please edit it with your API keys.');
  dotenv.config();
}

// Log environment variables (masked)
console.log('Environment variables loaded:');
console.log('- SPEECHMATICS_API_KEY:', process.env.SPEECHMATICS_API_KEY ? '✓ Present' : '✗ Missing');
console.log('- ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? '✓ Present' : '✗ Missing');
console.log('- PORT:', process.env.PORT || '3000 (default)');

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Anthropic = require('@anthropic-ai/sdk');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// Set up WebSocket server
const wss = new WebSocket.Server({ server });

// Check API keys before initializing clients
const speechmaticsKeyValid = !!process.env.SPEECHMATICS_API_KEY && process.env.SPEECHMATICS_API_KEY.length > 10;
const anthropicKeyValid = !!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 10;

// Log API key status
console.log('API Key Validation:');
console.log('- Speechmatics API Key:', speechmaticsKeyValid ? 'Valid format' : 'Invalid or missing');
console.log('- Anthropic API Key:', anthropicKeyValid ? 'Valid format' : 'Invalid or missing');

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
  let apiResponseReceived = false;
  
  ws.on('message', async (message) => {
    const data = JSON.parse(message);
    
    if (data.type === 'start') {
      // Check if Speechmatics API key is valid before connecting
      if (!speechmaticsKeyValid) {
        console.error('Invalid or missing Speechmatics API key');
        ws.send(JSON.stringify({
          type: 'status',
          status: 'apiError',
          message: 'Speechmatics API key missing'
        }));
        ws.send(JSON.stringify({
          type: 'error',
          text: 'Speechmatics API key is missing or invalid. Please check your .env file.'
        }));
        return;
      }
      
      // Initialize Speechmatics WebSocket connection
      const speechmaticsUrl = 'wss://eu2.rt.speechmatics.com/v2';
      speechmaticsWs = new WebSocket(speechmaticsUrl);
      
      // Send status update to client
      ws.send(JSON.stringify({
        type: 'status',
        status: 'apiConnecting',
        message: 'Connecting to Speechmatics API...'
      }));
      
      speechmaticsWs.on('open', () => {
        console.log('Connected to Speechmatics');
        
        // Send status update to client
        ws.send(JSON.stringify({
          type: 'status',
          status: 'apiConnected',
          message: 'Connected to Speechmatics API'
        }));
        
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
        
        // Set Claude's initial status to waiting
        ws.send(JSON.stringify({
          type: 'status',
          status: 'claudeWaiting',
          message: 'Claude waiting for input'
        }));
        
        speechmaticsWs.send(JSON.stringify(config));
      });
      
      speechmaticsWs.on('message', async (speechmaticsMessage) => {
        const response = JSON.parse(speechmaticsMessage);
        console.log('Speechmatics response type:', response.type);
        
        // Handle authentication errors
        if (response.type === 'not_authorised') {
          console.error('Speechmatics authentication error:', response);
          ws.send(JSON.stringify({
            type: 'status',
            status: 'apiError',
            message: 'Speechmatics API key error'
          }));
          ws.send(JSON.stringify({
            type: 'error',
            text: 'Speechmatics API authorization failed. Please check your API key.'
          }));
          return;
        }
        
        // Handle recognition started event
        if (response.type === 'RecognitionStarted') {
          console.log('Recognition started successfully');
          ws.send(JSON.stringify({
            type: 'status',
            status: 'apiProcessing',
            message: 'Speech recognition active'
          }));
        }
        
        // When receiving the first response, update the API status
        if (!apiResponseReceived && (response.type === 'AddTranscript' || response.type === 'AddPartialTranscript')) {
          apiResponseReceived = true;
          ws.send(JSON.stringify({
            type: 'status',
            status: 'apiProcessing',
            message: 'Speech recognition active'
          }));
        }
        
        if (response.type === 'AddTranscript' || response.type === 'AddPartialTranscript') {
          const transcript = response.metadata.transcript;
          console.log(`${response.type}:`, transcript);
          
          // Update speech detection status
          ws.send(JSON.stringify({
            type: 'status',
            status: 'speechDetected',
            message: 'Speech detected'
          }));
          
          // Send transcript to client
          ws.send(JSON.stringify({
            type: 'transcript',
            text: transcript,
            isFinal: response.type === 'AddTranscript'
          }));
          
          // If it's a final transcript, send to Claude
          if (response.type === 'AddTranscript' && transcript.trim().length > 0) {
            console.log('SENDING TO CLAUDE:', transcript);
            // Update API status to show final transcript received
            ws.send(JSON.stringify({
              type: 'status',
              status: 'apiFinalTranscript',
              message: 'Final transcript received'
            }));
            // Add user message to history
            messageHistory.push({
              role: 'user',
              content: transcript,
            });
            
            try {
              // Update Claude status
              ws.send(JSON.stringify({
                type: 'status',
                status: 'claudeProcessing',
                message: 'Claude processing request'
              }));
              
              // Log API key presence (masked for security)
              const apiKeyExists = !!process.env.ANTHROPIC_API_KEY;
              const maskedKey = apiKeyExists 
                ? `${process.env.ANTHROPIC_API_KEY.substring(0, 4)}...${process.env.ANTHROPIC_API_KEY.substring(process.env.ANTHROPIC_API_KEY.length - 4)}`
                : 'not found';
              console.log(`Anthropic API Key: ${apiKeyExists ? 'exists' : 'missing'} (${maskedKey})`);
              console.log('Anthropic client initialized:', !!anthropic);
              
              // Log what we're sending to Claude
              console.log('Sending to Claude API:', {
                model: 'claude-3-opus-20240229',
                max_tokens: 1000,
                message_count: messageHistory.length + 1, // +1 for system message
                system_message: 'You are a helpful voice assistant. Respond concisely as you are part of a real-time conversation.'
              });
              
              // Get response from Claude
              console.log('Calling Anthropic API...');
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
              
              console.log('Anthropic API call successful!');
              
              const assistantMessage = claudeResponse.content[0].text;
              console.log('Claude response:', assistantMessage);
              
              // Update Claude status
              ws.send(JSON.stringify({
                type: 'status',
                status: 'claudeResponded',
                message: 'Claude responded'
              }));
              
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
              
              // After a short delay, reset Claude status to waiting
              setTimeout(() => {
                ws.send(JSON.stringify({
                  type: 'status',
                  status: 'claudeWaiting',
                  message: 'Claude waiting for input'
                }));
              }, 3000);
            } catch (error) {
              console.error('Error getting response from Claude:', error.message);
              console.error('Error details:', error);
              
              // Provide more specific error message based on error type
              let errorMessage = 'Error getting AI response';
              let statusMessage = 'Error with Claude';
              
              if (error.status === 401) {
                errorMessage = 'Invalid API key or authentication error';
                statusMessage = 'API key error';
              } else if (error.message.includes('API key')) {
                errorMessage = 'Missing or invalid API key';
                statusMessage = 'API key error';
              } else if (error.type === 'network_error') {
                errorMessage = 'Network error connecting to Claude API';
                statusMessage = 'Network error';
              } else if (error.message.includes('timeout')) {
                errorMessage = 'Request to Claude API timed out';
                statusMessage = 'Timeout error';
              }
              
              ws.send(JSON.stringify({
                type: 'status',
                status: 'claudeError',
                message: statusMessage
              }));
              
              ws.send(JSON.stringify({
                type: 'error',
                text: errorMessage
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
    } else if (data.type === 'forceClaudeStatus') {
      // Manual trigger for Claude status update (for debugging)
      ws.send(JSON.stringify({
        type: 'status',
        status: data.status,
        message: data.message || 'Status updated manually'
      }));
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