const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const util = require('util');

// Set up logging to file
const logFile = fs.createWriteStream(path.join(__dirname, '../logs/server.log'), { flags: 'a' });
const errorLogFile = fs.createWriteStream(path.join(__dirname, '../logs/error.log'), { flags: 'a' });

// Custom logger
const logger = {
  log: function(message) {
    const timestamp = new Date().toISOString();
    logFile.write(`${timestamp} - ${message}\n`);
    // Keep console clean for important messages only
  },
  debug: function(message) {
    const timestamp = new Date().toISOString();
    logFile.write(`${timestamp} - DEBUG: ${message}\n`);
    // Don't print debug messages to console
  },
  info: function(message) {
    const timestamp = new Date().toISOString();
    logFile.write(`${timestamp} - INFO: ${message}\n`);
    console.log(message);
  },
  warn: function(message) {
    const timestamp = new Date().toISOString();
    logFile.write(`${timestamp} - WARN: ${message}\n`);
    console.warn(message);
  },
  error: function(message, error) {
    const timestamp = new Date().toISOString();
    const errorMsg = `${timestamp} - ERROR: ${message}`;
    logFile.write(`${errorMsg}\n`);
    errorLogFile.write(`${errorMsg}\n`);
    if (error) {
      errorLogFile.write(`${timestamp} - STACK: ${util.inspect(error)}\n`);
    }
    console.error(message);
  }
};

// Check if logs directory exists
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
  logger.info('Created logs directory');
}

// Check if .env file exists
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  logger.info('.env file found at: ' + envPath);
  dotenv.config();
} else {
  logger.warn('Warning: .env file not found at: ' + envPath);
  logger.warn('Please create a .env file with your API keys (see .env.example)');
  // Create a default .env file with placeholders
  const envExample = fs.readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8');
  fs.writeFileSync(envPath, envExample, 'utf8');
  logger.info('Created placeholder .env file. Please edit it with your API keys.');
  dotenv.config();
}

// Log environment variables (masked)
logger.info('Environment variables loaded:');
logger.info('- SPEECHMATICS_API_KEY: ' + (process.env.SPEECHMATICS_API_KEY ? '✓ Present' : '✗ Missing'));
logger.info('- ANTHROPIC_API_KEY: ' + (process.env.ANTHROPIC_API_KEY ? '✓ Present' : '✗ Missing'));
logger.info('- PORT: ' + (process.env.PORT || '3000 (default)'));

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
// Speechmatics API keys are typically 32 characters long
const speechmaticsKeyValid = !!process.env.SPEECHMATICS_API_KEY && 
                             process.env.SPEECHMATICS_API_KEY.length >= 32 && 
                             /^[a-zA-Z0-9]+$/.test(process.env.SPEECHMATICS_API_KEY);

// Anthropic API keys typically start with 'sk-ant-' and are longer than 30 characters
const anthropicKeyValid = !!process.env.ANTHROPIC_API_KEY && 
                          process.env.ANTHROPIC_API_KEY.length > 30 &&
                          process.env.ANTHROPIC_API_KEY.startsWith('sk-ant-');

// Log API key status
logger.info('API Key Validation:');
logger.info('- Speechmatics API Key: ' + (speechmaticsKeyValid ? 'Valid format' : 'Invalid or missing'));
logger.info('- Anthropic API Key: ' + (anthropicKeyValid ? 'Valid format' : 'Invalid or missing'));

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Store ongoing conversations
const conversations = new Map();

// Audio recording directory
const audioDir = path.join(__dirname, '../recordings');
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
  logger.info('Created recordings directory');
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
  logger.info('Client connected');
  
  // Generate a unique ID for this conversation
  const conversationId = Date.now().toString();
  let messageHistory = [];

  // Initialize Speechmatics connection
  let speechmaticsWs = null;
  let apiResponseReceived = false; // Track if we've received a successful API response
  let connectionSuccessful = false; // Track if we've established a successful connection
  let config = null; // Store config for potential reconnection attempts
  let speechmaticsConnecting = false; // Flag to track connection attempts
  let speechmaticsConnectionClosing = false; // Flag to track closing state
  let recognitionStarted = false; // Flag to track if recognition has started
  let lastSeqNo = 0; // Track the last sequence number from Speechmatics AudioAdded messages
  
  // Audio recording variables
  let isRecording = false;
  let recordingStream = null;
  let recordingBuffer = []; // To collect audio chunks
  let recordingStartTime = null;
  let recordingFilePath = null;
  let recordingSampleRate = 16000; // Default to 16kHz
  
  // Transcript buffering variables
  let transcriptBuffer = [];
  let lastSpeechTime = null;
  let silenceTimer = null;
  const SILENCE_THRESHOLD = 2000; // 2 seconds of silence to trigger sending
  logger.info(`Initializing with silence threshold of ${SILENCE_THRESHOLD}ms`);
  
  // Define a reusable message handler for Speechmatics 
  const handleSpeechmaticsMessage = async (speechmaticsMessage) => {
    try {
      const response = JSON.parse(speechmaticsMessage);
      
      // Filter out AudioAdded messages from console (still log to file)
      if (response.message === 'AudioAdded') {
        // Track the sequence number from Speechmatics
        lastSeqNo = response.seq_no;
        
        // Only log every 100th AudioAdded message to avoid filling logs
        if (response.seq_no % 100 === 0) {
          logger.debug(`Speechmatics AudioAdded: seq_no ${response.seq_no}`);
        }
      } else {
        // Log other message types normally
        logger.debug('Speechmatics response type: ' + 
          (response.type || response.message || 'unknown') +
          ' message: ' + (response.message || 'none'));
        
        // Full response to debug log
        logger.debug('Full Speechmatics response: ' + JSON.stringify(response, null, 2));
      }
      
      // Handle various error types (simplified - main handler has full implementation)
      if ((response.message === 'Error' || response.message === 'Info') && 
          (response.type === 'concurrent_session_usage' || 
          response.type === 'protocol_error' ||
          response.type === 'not_authorised')) {
        logger.error(`Speechmatics ${response.message} (${response.type}): ` + JSON.stringify(response));
        return;
      }
      
      // Process normal messages
      if (response.message === 'RecognitionStarted') {
        logger.info('Recognition started successfully');
        ws.send(JSON.stringify({
          type: 'status',
          status: 'apiProcessing',
          message: 'Speech recognition active'
        }));
      }
      
      if (response.message === 'AddTranscript' || response.message === 'AddPartialTranscript') {
        const transcript = response.metadata.transcript;
        const isPartial = response.message === 'AddPartialTranscript';
        
        // Only log and send non-empty transcripts
        if (transcript.trim().length > 0) {
          logger.debug(`Speechmatics ${isPartial ? 'PARTIAL' : 'FINAL'} transcript: "${transcript}"`);
          
          // Update status only for non-empty transcripts
          ws.send(JSON.stringify({
            type: 'status',
            status: 'speechDetected',
            message: 'Speech detected'
          }));
          
          // Send to client only if it's final (not partial) and has content
          if (!isPartial) {
            ws.send(JSON.stringify({
              type: 'transcript',
              text: transcript,
              isFinal: true,
              source: 'speechmatics'
            }));
          }
        }
        
        if (!isPartial && transcript.trim().length > 0) {
          logger.debug('Received final transcript in handler (not sending to Claude): ' + transcript);
          
          // This is just a stub for reconnection purposes
          // The actual Claude API call happens in the main message handler with buffering
        }
      }
    } catch (error) {
      console.error('Error parsing Speechmatics message in handler:', error);
      console.log('Raw message:', speechmaticsMessage);
    }
  };
  
  ws.on('message', async (message) => {
    const data = JSON.parse(message);
    
    if (data.type === 'startRecording') {
      // Start recording audio to file
      isRecording = true;
      recordingBuffer = [];
      recordingStartTime = new Date();
      recordingFilePath = path.join(audioDir, `recording-${Date.now()}.pcm`);
      logger.info(`Starting audio recording to ${recordingFilePath}`);
      
      // Inform client that recording has started
      ws.send(JSON.stringify({
        type: 'info',
        text: `Recording audio to ${recordingFilePath}`
      }));
    } else if (data.type === 'stopRecording') {
      // Stop recording and save the file
      if (isRecording) {
        isRecording = false;
        
        if (recordingBuffer.length > 0) {
          // Create a binary buffer from all the audio chunks
          const combinedBuffer = Buffer.concat(recordingBuffer);
          
          // Write raw PCM data to file
          fs.writeFile(recordingFilePath, combinedBuffer, (err) => {
            if (err) {
              logger.error(`Error saving audio recording: ${err.message}`, err);
              ws.send(JSON.stringify({
                type: 'error',
                text: 'Failed to save audio recording'
              }));
            } else {
              // Create WAV file from PCM
              const wavFilePath = recordingFilePath.replace('.pcm', '.wav');
              createWavFile(recordingFilePath, wavFilePath, combinedBuffer.length, recordingSampleRate, () => {
                // Send download link to client
                const fileName = path.basename(wavFilePath);
                ws.send(JSON.stringify({
                  type: 'audioRecorded',
                  filePath: `/recordings/${fileName}`,
                  duration: (new Date() - recordingStartTime) / 1000
                }));
                
                logger.info(`Audio recording saved to ${wavFilePath}`);
              });
            }
          });
        } else {
          logger.info('No audio data recorded');
          ws.send(JSON.stringify({
            type: 'info',
            text: 'No audio data was recorded'
          }));
        }
        
        // Reset recording variables
        recordingBuffer = [];
        recordingStartTime = null;
      }
    } else if (data.type === 'start') {
      // Check if there's already an active connection
      if (speechmaticsWs && speechmaticsWs.readyState !== WebSocket.CLOSED) {
        logger.info('Cleaning up existing Speechmatics connection before starting a new one');
        cleanupSpeechmaticsConnection();
      }
      
      // Prevent multiple simultaneous connection attempts
      if (speechmaticsConnecting) {
        logger.warn('Connection attempt already in progress, ignoring duplicate start request');
        return;
      }
      
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
      // Note: Node.js WebSocket API requires us to use headers in the options object
      const speechmaticsUrl = 'wss://eu2.rt.speechmatics.com/v2';
      
      const options = {
        headers: {
          'Authorization': `Bearer ${process.env.SPEECHMATICS_API_KEY}`
        },
        // Add proper ping/pong settings as per Speechmatics docs
        pingInterval: 30000, // 30 seconds
        pingTimeout: 60000   // 60 seconds
      };
      
      // Log connection attempt
      console.log('Connecting to Speechmatics with API key (masked):', 
        process.env.SPEECHMATICS_API_KEY ? 
        `${process.env.SPEECHMATICS_API_KEY.substring(0, 4)}...${process.env.SPEECHMATICS_API_KEY.substring(process.env.SPEECHMATICS_API_KEY.length - 4)}` : 
        'missing');
        
      // Set connection flag and create the WebSocket connection
      speechmaticsConnecting = true;
      speechmaticsWs = new WebSocket(speechmaticsUrl, options);
      
      // Send status update to client
      ws.send(JSON.stringify({
        type: 'status',
        status: 'apiConnecting',
        message: 'Connecting to Speechmatics API...'
      }));
      
      // Add a connection timeout to prevent stuck "connecting" state
      const connectionTimeout = setTimeout(() => {
        if (speechmaticsWs.readyState !== WebSocket.OPEN) {
          logger.error('Speechmatics connection timeout after 10 seconds');
          
          // Update client status
          ws.send(JSON.stringify({
            type: 'status',
            status: 'apiError',
            message: 'Connection timeout'
          }));
          
          // Send error message to client
          ws.send(JSON.stringify({
            type: 'error',
            text: 'Connection to Speechmatics timed out. Please try again.'
          }));
          
          // Close the connection if it's not already closed
          if (speechmaticsWs.readyState !== WebSocket.CLOSED) {
            speechmaticsWs.close();
          }
        }
      }, 10000); // 10 second timeout
      
      speechmaticsWs.on('open', () => {
        console.log('Connected to Speechmatics');
        
        // Clear connection timeout since we're connected successfully
        clearTimeout(connectionTimeout);
        
        // Mark connection as successful to prevent unnecessary retries
        connectionSuccessful = true;
        
        // Send status update to client
        ws.send(JSON.stringify({
          type: 'status',
          status: 'apiConnected',
          message: 'Connected to Speechmatics API'
        }));
        
        // Send configuration to Speechmatics - store in outer scope for reconnection
        config = {
          message: 'StartRecognition',
          audio_format: {
            type: 'raw',
            encoding: 'pcm_s16le',
            sample_rate: 16000
          },
          transcription_config: {
            language: 'en',
            operating_point: 'standard',
            enable_partials: true,
            diarization: "speaker",
            max_delay: 4,
            max_delay_mode: "flexible"
          }
        };
        
        // Reset transcript buffer and timers
        transcriptBuffer = [];
        lastSpeechTime = null;
        if (silenceTimer) {
          clearTimeout(silenceTimer);
          silenceTimer = null;
        }
        
        // Reset connection tracking flags
        apiResponseReceived = false;
        connectionSuccessful = false;
        recognitionStarted = false;
        
        // Set Claude's initial status to waiting
        ws.send(JSON.stringify({
          type: 'status',
          status: 'claudeWaiting',
          message: 'Claude waiting for input'
        }));
        
        speechmaticsWs.send(JSON.stringify(config));
      });
      
      speechmaticsWs.on('message', async (speechmaticsMessage) => {
        try {
          const response = JSON.parse(speechmaticsMessage);
          
          // Filter out AudioAdded messages from console (still log to file)
          if (response.message === 'AudioAdded') {
            // Only log every 100th AudioAdded message to avoid filling logs
            if (response.seq_no % 100 === 0) {
              logger.debug(`Speechmatics AudioAdded: seq_no ${response.seq_no}`);
            }
          } else {
            // Log other message types normally
            logger.info('Speechmatics response type: ' + 
              (response.type || response.message || 'unknown') +
              ' message: ' + (response.message || 'none'));
            
            // Full response to debug log
            logger.debug('Full Speechmatics response: ' + JSON.stringify(response, null, 2));
          }
          
          // Handle various error/info/warning messages
          if (response.message === 'Error' && response.type === 'not_authorised') {
            logger.error('Speechmatics authentication error: ' + JSON.stringify(response));
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
          else if (response.message === 'Info' && response.type === 'concurrent_session_usage') {
            logger.error('Speechmatics concurrent session error: ' + JSON.stringify(response));
          
            // Update client on status
            ws.send(JSON.stringify({
              type: 'status',
              status: 'apiRetrying',
              message: 'Session limit - retrying'
            }));
            
            // Send info to client
            ws.send(JSON.stringify({
              type: 'info',
              text: 'Another session is active. Waiting to retry in 5 seconds...'
            }));
            
            // Clean up current connection first and then retry
            // First check if we've already received RecognitionStarted or have a successful connection
            if (apiResponseReceived || connectionSuccessful || recognitionStarted) {
              logger.info('Connection already established or recognition started, not retrying connection');
              return;
            }
            
            // Use the promise-based cleanup to ensure connection is fully closed before retrying
            cleanupSpeechmaticsConnection().then(() => {
              // Double check if we've received anything while closing
              if (apiResponseReceived) {
                logger.info('Received API response during cleanup, not retrying connection');
                return;
              }
              
              // Set up retry mechanism with delay
              setTimeout(() => {
                // Only retry if we're not already connecting
                if (speechmaticsConnecting) {
                  logger.warn('Already connecting, skipping retry attempt');
                  return;
                }
                
                logger.info('Retrying Speechmatics connection after concurrent session error');
                
                // Set connection flag and create new connection
                speechmaticsConnecting = true;
                speechmaticsWs = new WebSocket(speechmaticsUrl, options);
                
                // Add a connection timeout for retry attempt
                const retryConnectionTimeout = setTimeout(() => {
                  if (speechmaticsWs.readyState !== WebSocket.OPEN) {
                  logger.error('Speechmatics retry connection timeout after 10 seconds');
                  
                    // Update client status
                    ws.send(JSON.stringify({
                      type: 'status',
                      status: 'apiError',
                      message: 'Retry connection timeout'
                  }));
                  
                    // Send error message to client
                    ws.send(JSON.stringify({
                      type: 'error',
                      text: 'Reconnection to Speechmatics timed out. Please try again later.'
                  }));
                  
                    // Close the connection if it's not already closed
                    if (speechmaticsWs.readyState !== WebSocket.CLOSED) {
                      speechmaticsWs.close();
                    }
                  }
                }, 10000); // 10 second timeout
              
                // Re-attach all the same event handlers
                // (This is simplified, ideally we'd refactor to avoid duplication)
                speechmaticsWs.on('open', () => {
                logger.info('Retry connection to Speechmatics successful');
                
                // Clear retry connection timeout
                clearTimeout(retryConnectionTimeout);
                
                ws.send(JSON.stringify({
                  type: 'status',
                  status: 'apiConnected',
                  message: 'Reconnected to Speechmatics'
                }));
                
                // Send the same config as before
                speechmaticsWs.send(JSON.stringify(config));
              });
              
                // Re-attach the new version of message handler
                speechmaticsWs.on('message', handleSpeechmaticsMessage);
                
                // Re-add error handler
                speechmaticsWs.on('error', (error) => {
                logger.error('Speechmatics WebSocket error: ' + error.message, error);
                ws.send(JSON.stringify({
                  type: 'error',
                  text: 'Speech recognition error'
                }));
              });
              
                // Re-add close handler
                speechmaticsWs.on('close', () => {
                  logger.info('Disconnected from Speechmatics');
                });
              });
            }, 5000); // 5-second delay before retry
            
            return;
          }
          else if (response.message === 'Error' && response.type === 'protocol_error') {
            logger.error('Speechmatics protocol error: ' + JSON.stringify(response));
            ws.send(JSON.stringify({
              type: 'status',
              status: 'apiError',
              message: 'Protocol error'
            }));
            ws.send(JSON.stringify({
              type: 'error',
              text: 'Communication error with Speechmatics. Please try again.'
            }));
            return;
          }
          else if (response.message === 'Error') {
            logger.error('Speechmatics error: ' + JSON.stringify(response));
            ws.send(JSON.stringify({
              type: 'status',
              status: 'apiError',
              message: 'API error'
            }));
            ws.send(JSON.stringify({
              type: 'error',
              text: `Speechmatics error: ${response.reason || 'Unknown error'}`
            }));
            return;
          }
        
          // Handle recognition started event
          if (response.message === 'RecognitionStarted') {
            logger.info('Recognition started successfully: ' + JSON.stringify(response));
            // Set flags to indicate successful connection and recognition
            apiResponseReceived = true;
            recognitionStarted = true;
            connectionSuccessful = true;
            
            ws.send(JSON.stringify({
              type: 'status',
              status: 'apiProcessing',
              message: 'Speech recognition active'
            }));
          }
          
          // When receiving the first transcript, update the API status
          if (!apiResponseReceived && (response.message === 'AddTranscript' || response.message === 'AddPartialTranscript')) {
            apiResponseReceived = true;
            ws.send(JSON.stringify({
              type: 'status',
              status: 'apiProcessing',
              message: 'Speech recognition active'
            }));
          }
          
          if (response.message === 'AddTranscript' || response.message === 'AddPartialTranscript') {
            const transcript = response.metadata.transcript;
            const isPartial = response.message === 'AddPartialTranscript';
            
            // Only log non-empty transcripts
            if (transcript.trim().length > 0) {
              logger.info(`Speechmatics ${isPartial ? 'PARTIAL' : 'FINAL'} transcript: "${transcript}"`);
            } else {
              // Just log empty transcripts to debug
              logger.debug(`Speechmatics ${isPartial ? 'PARTIAL' : 'FINAL'} empty transcript received`);
            }
            
            // Update speech detection status - only if transcript has content
            if (transcript.trim().length > 0) {
              ws.send(JSON.stringify({
                type: 'status',
                status: 'speechDetected',
                message: 'Speech detected'
              }));
            }
            
            // Send transcript to client - only if it's final (not partial) and has content
            if (!isPartial && transcript.trim().length > 0) {
              ws.send(JSON.stringify({
                type: 'transcript',
                text: transcript,
                isFinal: true,
                source: 'speechmatics'
              }));
            }
            
            // If we have a transcript with content, update speech detection time
            if (transcript.trim().length > 0) {
              // Update the last time we detected speech
              lastSpeechTime = new Date();
              
              // For final transcripts, add to our buffer
              if (!isPartial) {
                // Add to transcript buffer
                transcriptBuffer.push(transcript);
                logger.info('Added to transcript buffer: "' + transcript + '"');
                logger.info('Current buffer size: ' + transcriptBuffer.length + ' segments');
                
                // Reset any existing silence timer
                if (silenceTimer) {
                  logger.info('Resetting existing silence timer because new speech was detected');
                  clearTimeout(silenceTimer);
                }
                
                // Start a new silence timer
                logger.info(`Starting silence timer (${SILENCE_THRESHOLD}ms) for transcript buffering`);
                silenceTimer = setTimeout(async () => {
                  if (transcriptBuffer.length > 0) {
                    // Join all buffered transcripts with spaces
                    const fullTranscript = transcriptBuffer.join(' ');
                    logger.info('SILENCE DETECTED - SENDING TO CLAUDE: "' + fullTranscript + '"');
                    
                    // Update API status to show final transcript received
                    ws.send(JSON.stringify({
                      type: 'status',
                      status: 'apiFinalTranscript',
                      message: 'Final transcript received'
                    }));
                    
                    // Send the complete transcript to the client
                    ws.send(JSON.stringify({
                      type: 'completeTranscript',
                      text: fullTranscript,
                      isFinal: true,
                      source: 'speechmatics'
                    }));
                    
                    // Add the full, combined transcript to history
                    messageHistory.push({
                      role: 'user',
                      content: fullTranscript,
                    });
                    
                    // Clear the buffer after sending
                    transcriptBuffer = [];
                    
                    // Call the Claude API with the complete transcript
                    try {
                      // Update Claude status
                      ws.send(JSON.stringify({
                        type: 'status',
                        status: 'claudeProcessing',
                        message: 'Claude processing request'
                      }));
                      
                      // Get response from Claude
                      logger.info('Calling Anthropic API with buffered transcripts: "' + fullTranscript + '"');
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
                      
                      logger.info('Anthropic API call successful! Model: ' + claudeResponse.model);
                      
                      const assistantMessage = claudeResponse.content[0].text;
                      logger.info('Claude response: ' + assistantMessage);
                      
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
                      logger.error('Error getting response from Claude: ' + error.message, error);
                      
                      // Error handling
                      ws.send(JSON.stringify({
                        type: 'status',
                        status: 'claudeError',
                        message: 'Error with Claude'
                      }));
                      
                      ws.send(JSON.stringify({
                        type: 'error',
                        text: 'Error getting AI response'
                      }));
                    }
                  }
                  logger.info('Silence timer executed and completed');
                  silenceTimer = null;
                }, SILENCE_THRESHOLD);
              }
              
              // Note: We now trigger Claude API call inside the silenceTimer callback instead of here
              // The original code has been moved to the silence detection timer callback
            }
          }
        } catch (error) {
          logger.error('Error parsing Speechmatics message: ' + error.message, error);
          logger.debug('Raw message: ' + speechmaticsMessage);
        }
      });
      
      speechmaticsWs.on('error', (error) => {
        logger.error('Speechmatics WebSocket error: ' + error.message, error);
        ws.send(JSON.stringify({
          type: 'error',
          text: 'Speech recognition error'
        }));
      });
      
      speechmaticsWs.on('close', () => {
        logger.info('Disconnected from Speechmatics');
        // Reset connection state flags
        speechmaticsConnecting = false;
        // Only set to null if we're intentionally closing
        // Otherwise leave it as is since we might be processing more messages
        if (speechmaticsConnectionClosing) {
          speechmaticsConnectionClosing = false;
          speechmaticsWs = null;
        }
      });
    } else if (data.type === 'audio') {
      // Forward audio data to Speechmatics
      if (speechmaticsWs && speechmaticsWs.readyState === WebSocket.OPEN) {
        // Speechmatics expects binary data, not JSON
        // Convert the array back to a binary Int16Array
        const audioArray = new Int16Array(data.audio);
        
        // If recording is enabled, store audio chunk
        if (isRecording) {
          recordingBuffer.push(Buffer.from(audioArray.buffer));
          recordingSampleRate = data.sample_rate || 16000; // Store the sample rate
        }
        
        // Send as binary data directly
        try {
          speechmaticsWs.send(audioArray.buffer);
          
          // For debugging
          if (Math.random() < 0.01) { // Only log ~1% of audio chunks to avoid log spam
            logger.debug(`Sent ${audioArray.length} samples of audio data (last_seq_no: ${lastSeqNo})`);
          }
        } catch (error) {
          logger.error('Error sending audio data: ' + error.message, error);
        }
      }
    } else if (data.type === 'stop') {
      // If we have any pending transcripts in the buffer, send them now
      (async () => {
        if (transcriptBuffer.length > 0) {
          // Clear any pending silence timer
          if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
          }
          
          // Join all buffered transcripts with spaces
          const fullTranscript = transcriptBuffer.join(' ');
          logger.info('STOP PRESSED - SENDING BUFFERED TRANSCRIPTS TO CLAUDE: "' + fullTranscript + '"');
          
          // Update API status
          ws.send(JSON.stringify({
            type: 'status',
            status: 'apiFinalTranscript',
            message: 'Final transcript received'
          }));
          
          // Send the complete transcript to the client
          ws.send(JSON.stringify({
            type: 'completeTranscript',
            text: fullTranscript,
            isFinal: true,
            source: 'speechmatics'
          }));
          
          // Add the full, combined transcript to history
          messageHistory.push({
            role: 'user',
            content: fullTranscript,
          });
          
          // Process with Claude API call (copy the relevant code section here)
          // Similar to what happens in the silence detection callback
          try {
            // Update Claude status
            ws.send(JSON.stringify({
              type: 'status',
              status: 'claudeProcessing',
              message: 'Claude processing request'
            }));
            
            // Get response from Claude
            logger.info('Calling Anthropic API with final buffer content: "' + fullTranscript + '"');
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
            
            logger.info('Anthropic API call successful! Model: ' + claudeResponse.model);
            
            const assistantMessage = claudeResponse.content[0].text;
            logger.info('Claude response: ' + assistantMessage);
            
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
            logger.error('Error getting response from Claude: ' + error.message, error);
            
            // Error handling (similar to existing code)
            ws.send(JSON.stringify({
              type: 'status',
              status: 'claudeError',
              message: 'Error with Claude'
            }));
            
            ws.send(JSON.stringify({
              type: 'error',
              text: 'Error getting AI response'
            }));
          }
          
          // Clear the buffer after sending
          transcriptBuffer = [];
        }
      })();
      
      // Clean up Speechmatics connection properly
      cleanupSpeechmaticsConnection().then(() => {
        logger.info('Connection cleanup completed after stop request');
      });
    } else if (data.type === 'forceClaudeStatus') {
      // Manual trigger for Claude status update (for debugging)
      ws.send(JSON.stringify({
        type: 'status',
        status: data.status,
        message: data.message || 'Status updated manually'
      }));
    }
  });
  
  // Function to properly close Speechmatics connection
  function cleanupSpeechmaticsConnection() {
    return new Promise((resolve) => {
      if (!speechmaticsWs) {
        logger.info('No Speechmatics connection to clean up');
        // Reset all state flags just to be safe
        speechmaticsConnecting = false;
        speechmaticsConnectionClosing = false;
        apiResponseReceived = false;
        connectionSuccessful = false;
        recognitionStarted = false;
        lastSeqNo = 0; // Reset sequence number
        resolve();
        return;
      }
      
      speechmaticsConnectionClosing = true;
      
      // Try to send EndOfStream if connection is open
      if (speechmaticsWs.readyState === WebSocket.OPEN) {
        try {
          // Format according to Speechmatics API requirements
          // Using the tracked sequence number from AudioAdded messages for proper EndOfStream message
          const endOfStreamCommand = {
            message: 'EndOfStream',
            last_seq_no: lastSeqNo
          };
          speechmaticsWs.send(JSON.stringify(endOfStreamCommand));
          logger.info('Sent EndOfStream to Speechmatics');
          
          // Allow time for the message to be sent before closing
          setTimeout(() => {
            if (speechmaticsWs && speechmaticsWs.readyState !== WebSocket.CLOSED) {
              speechmaticsWs.close();
              logger.info('Closed Speechmatics connection after EndOfStream');
            }
            // Don't resolve yet - wait for the close event to complete the cleanup
          }, 500); // 500ms should be plenty for the message to be processed
        } catch (error) {
          logger.error('Error sending EndOfStream: ' + error.message);
          forceCloseConnection();
        }
      } else {
        forceCloseConnection();
      }
      
      // Helper function to force close and resolve
      function forceCloseConnection() {
        if (speechmaticsWs && speechmaticsWs.readyState !== WebSocket.CLOSED) {
          speechmaticsWs.close();
          logger.info('Forced close of Speechmatics connection');
        }
        
        // Reset connection variables
        const oldWs = speechmaticsWs;
        speechmaticsWs = null;
        speechmaticsConnecting = false;
        speechmaticsConnectionClosing = false;
        apiResponseReceived = false;
        connectionSuccessful = false;
        recognitionStarted = false;
        lastSeqNo = 0; // Reset sequence number
        logger.info('Speechmatics connection cleanup complete');
        
        // Remove all listeners from the old WebSocket to avoid memory leaks
        if (oldWs) {
          oldWs.removeAllListeners();
        }
        
        resolve();
      }
      
      // Set up one-time close listener to resolve promise
      const originalWs = speechmaticsWs;
      if (originalWs) {
        originalWs.once('close', () => {
          logger.info('Handling WebSocket close event in cleanup function');
          // Reset variables
          if (speechmaticsWs === originalWs) {
            speechmaticsWs = null;
          }
          speechmaticsConnecting = false;
          speechmaticsConnectionClosing = false;
          apiResponseReceived = false;
          connectionSuccessful = false;
          recognitionStarted = false;
          lastSeqNo = 0; // Reset sequence number
          logger.info('Speechmatics connection cleanup complete from close event');
          
          // Remove all listeners from the old WebSocket to avoid memory leaks
          originalWs.removeAllListeners();
          
          resolve();
        });
      }
    });
  }

  ws.on('close', () => {
    logger.info('Client disconnected');
    // Clean up Speechmatics connection
    cleanupSpeechmaticsConnection().finally(() => {
      // Make sure we reset all state variables even if the promise fails
      speechmaticsWs = null;
      speechmaticsConnecting = false;
      speechmaticsConnectionClosing = false;
      apiResponseReceived = false;
      connectionSuccessful = false;
      recognitionStarted = false;
      lastSeqNo = 0; // Reset sequence number
      // Clean up conversation history
      conversations.delete(conversationId);
    });
  });
});

// Function to create a WAV file from PCM data
function createWavFile(pcmFilePath, wavFilePath, fileSize, sampleRate, callback) {
  // WAV header structure
  const numChannels = 1; // Mono
  sampleRate = sampleRate || 16000; // Use provided sample rate or default to 16 kHz
  const bitsPerSample = 16; // 16-bit PCM
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const subchunk2Size = fileSize;
  const chunkSize = 36 + subchunk2Size;
  
  // Create WAV header
  const header = Buffer.alloc(44);
  
  // RIFF chunk descriptor
  header.write('RIFF', 0);
  header.writeUInt32LE(chunkSize, 4);
  header.write('WAVE', 8);
  
  // FMT sub-chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  
  // Data sub-chunk
  header.write('data', 36);
  header.writeUInt32LE(subchunk2Size, 40);
  
  // Create write streams
  const wavStream = fs.createWriteStream(wavFilePath);
  
  // Write header
  wavStream.write(header);
  
  // Read the PCM file and pipe to WAV file
  fs.createReadStream(pcmFilePath).pipe(wavStream);
  
  // When finished, call the callback
  wavStream.on('finish', () => {
    if (callback) callback();
  });
}

// Add route to serve the recordings directory
app.use('/recordings', express.static(path.join(__dirname, '../recordings')));

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});