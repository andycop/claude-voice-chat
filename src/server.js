const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const util = require('util');

// Set up logging to file
const logFile = fs.createWriteStream(path.join(__dirname, '../logs/server.log'), { flags: 'a' });
const errorLogFile = fs.createWriteStream(path.join(__dirname, '../logs/error.log'), { flags: 'a' });

// Custom logger with flow logs only displayed to console
const logger = {
  log: function(message) {
    const timestamp = new Date().toISOString();
    logFile.write(`${timestamp} - ${message}\n`);
    // Don't show regular logs in console
  },
  debug: function(message) {
    const timestamp = new Date().toISOString();
    logFile.write(`${timestamp} - DEBUG: ${message}\n`);
    // Don't show debug logs in console
  },
  info: function(message) {
    const timestamp = new Date().toISOString();
    logFile.write(`${timestamp} - INFO: ${message}\n`);
    // Don't show info logs in console
  },
  warn: function(message) {
    const timestamp = new Date().toISOString();
    logFile.write(`${timestamp} - WARN: ${message}\n`);
    // Don't show warning logs in console
  },
  error: function(message, error) {
    const timestamp = new Date().toISOString();
    const errorMsg = `${timestamp} - ERROR: ${message}`;
    logFile.write(`${errorMsg}\n`);
    errorLogFile.write(`${errorMsg}\n`);
    if (error) {
      errorLogFile.write(`${timestamp} - STACK: ${util.inspect(error)}\n`);
    }
    // Only show errors in console as they're critical
    console.error(message);
  },
  // Method for flow-level logging - the only log type shown in console
  flow: function(direction, service, messageType) {
    const timestamp = new Date().toISOString();
    const arrow = direction === 'SEND' ? '→' : '←';
    const flowMsg = `${timestamp} - FLOW: ${arrow} ${service} | ${messageType}`;
    logFile.write(`${flowMsg}\n`);
    // console.log(flowMsg);
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
  const envExamplePath = path.resolve(process.cwd(), '.env.example');
  if (fs.existsSync(envExamplePath)) {
    logger.info(`Found .env.example at ${envExamplePath}, creating .env file from it.`);
    const envExampleContent = fs.readFileSync(envExamplePath, 'utf8');
    fs.writeFileSync(envPath, envExampleContent, 'utf8');
    logger.info(`Created placeholder .env file at ${envPath}. If API keys are not set via environment variables, please edit this file.`);
  } else {
    logger.warn(`Warning: .env.example file not found at ${envExamplePath}.`);
    logger.warn('Continuing without creating a .env file. Ensure necessary environment variables are set externally (e.g., via Docker).');
  }
  // Load .env if it was created or already exists (and wasn't caught by the first if).
  // If no .env file, dotenv.config() does nothing harmful.
  // Variables from process.env (e.g., set by Docker) take precedence over .env file vars by default.
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
  let autoShutoffTimer = null; // Timer for auto-shutoff after prolonged silence
  let emptyTranscriptCount = 0; // Counter for empty AddTranscript messages
  let isProcessingTranscript = false; // Flag to prevent duplicate processing
  const SILENCE_THRESHOLD = 2000; // 2 seconds of silence to trigger sending
  const EMPTY_TRANSCRIPT_THRESHOLD = 3; // Number of empty transcripts to consider as silence
  const AUTO_SHUTOFF_THRESHOLD = 60000; // 60 seconds (1 minute) of silence to trigger auto-shutoff
  logger.info(`Initializing with silence threshold of ${SILENCE_THRESHOLD}ms and auto-shutoff threshold of ${AUTO_SHUTOFF_THRESHOLD}ms`);

  /**
   * Auto-shutoff function after prolonged silence
   * Stops the connection to Speechmatics to prevent incurring costs
   */
  function triggerAutoShutoff() {
    logger.info('Auto-shutoff triggered due to prolonged silence');
    
    // Process any pending transcripts first
    if (transcriptBuffer.length > 0) {
      processFinalTranscriptAndReset('Auto-shutoff silence detection');
    }
    
    // Clear auto-shutoff timer
    if (autoShutoffTimer) {
      clearTimeout(autoShutoffTimer);
      autoShutoffTimer = null;
    }
    
    // Send a message to the client
    ws.send(JSON.stringify({
      type: 'info',
      text: 'Listening automatically stopped due to prolonged silence (1 minute)'
    }));
    
    // Send shutoff event to client
    ws.send(JSON.stringify({
      type: 'autoShutoff',
      message: 'Listening automatically stopped due to prolonged silence'
    }));
    
    // Clean up Speechmatics connection
    cleanupSpeechmaticsConnection().then(() => {
      logger.info('Connection cleanup completed after auto-shutoff');
      
      // Update statuses
      ws.send(JSON.stringify({
        type: 'status',
        status: 'apiInactive',
        message: 'Speech recognition inactive'
      }));
      
      ws.send(JSON.stringify({
        type: 'status',
        status: 'speechInactive',
        message: 'Speech detection inactive'
      }));
    });
  }
  
  /**
   * Process final transcript and send to Claude
   * @param {string} reason - The reason for processing (e.g., silence detection, stop button)
   */
  async function processFinalTranscriptAndReset(reason) {
    // Check if we're already processing a transcript to avoid duplicate calls
    if (isProcessingTranscript) {
      logger.flow('PROC', 'Server', `Skipping duplicate processing triggered by: ${reason} (already processing)`);
      return;
    }
    
    if (transcriptBuffer.length === 0) {
      logger.flow('PROC', 'Server', `No transcripts in buffer to process (triggered by: ${reason})`);
      return;
    }
    
    // Set processing flag to prevent duplicate calls
    isProcessingTranscript = true;
    
    // Join all buffered transcripts with spaces
    const fullTranscript = transcriptBuffer.join(' ');
    logger.flow('PROC', 'Server', `${reason} - sending transcript: "${fullTranscript.substring(0, 30)}${fullTranscript.length > 30 ? '...' : ''}"`);
    
    // We only send EndOfStream when the user explicitly stops listening
    // No EndOfStream is sent during silence detection or empty transcript detection
    
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
    
    // Call the Claude API with the complete transcript
    try {
      // Update Claude status
      ws.send(JSON.stringify({
        type: 'status',
        status: 'claudeProcessing',
        message: 'Claude processing request'
      }));
      
      // Get response from Claude
      logger.flow('SEND', 'Anthropic', `API request with transcript: "${fullTranscript.substring(0, 30)}${fullTranscript.length > 30 ? '...' : ''}"`);
      const claudeResponse = await anthropic.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1000,
        system: 'You are a helpful voice assistant. Respond concisely as you are part of a real-time conversation. Format your responses using Markdown when appropriate - you can use bold, italics, links, lists, code blocks, etc. to structure your responses.',
        messages: messageHistory
      });
      
      logger.flow('RECV', 'Anthropic', `API response received: model=${claudeResponse.model}`);
      
      const assistantMessage = claudeResponse.content[0].text;
      logger.flow('RECV', 'Anthropic', `Response: "${assistantMessage.substring(0, 30)}${assistantMessage.length > 30 ? '...' : ''}"`);
      
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
      logger.flow('ERROR', 'Anthropic', `API error: ${error.message}`);
      
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
    
    // Clear the buffer after sending
    transcriptBuffer = [];
    
    // Reset silence detection variables
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    // DO NOT Reset auto-shutoff timer here. It should only be reset by new speech activity
    // or when the connection is started/stopped.
    emptyTranscriptCount = 0;
    
    // Reset processing flag
    isProcessingTranscript = false;
  }

  /**
   * Comprehensive message handler for Speechmatics API messages
   * @param {string} speechmaticsMessage - Raw message from Speechmatics API
   */
  async function handleSpeechmaticsMessage(speechmaticsMessage) {
    try {
      const response = JSON.parse(speechmaticsMessage);
      
      // Track message flow for all messages
      if (response.message === 'AudioAdded') {
        // Track the sequence number from Speechmatics
        lastSeqNo = response.seq_no;
        
        // Only log every 100th AudioAdded message to avoid filling logs
        if (response.seq_no % 100 === 0) {
          logger.flow('RECV', 'Speechmatics', `AudioAdded | seq_no: ${response.seq_no}`);
        }
      } else {
        // Log all other message types in the flow format
        logger.flow('RECV', 'Speechmatics', response.message || 'unknown');
        
        // Full response only to debug log for troubleshooting purposes
        logger.debug('Full Speechmatics response: ' + JSON.stringify(response, null, 2));
      }
      
      // Handle EndOfTranscript message
      if (response.message === 'EndOfTranscript') {
        logger.info('Received EndOfTranscript message from Speechmatics');
        // This message confirms all audio has been processed
        // This is a good place to trigger the final transcript processing
        // However, we're already doing that with the silence timer, so this is just informational
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
      } /* else if (response.message === 'Info' && response.type === 'concurrent_session_usage') {
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
            connectToSpeechmatics();
          }, 5000); // 5-second delay before retry
        });
        
        return;
      } */
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
      if (!apiResponseReceived && (response.message === 'AddTranscript')) {
        apiResponseReceived = true;
        ws.send(JSON.stringify({
          type: 'status',
          status: 'apiProcessing',
          message: 'Speech recognition active'
        }));
      }
      
      // Process AddTranscript messages
      if (response.message === 'AddTranscript') {
        const transcript = response.metadata.transcript;
        const hasContent = transcript.trim().length > 0;
        
        if (hasContent) {
          // Reset empty transcript counter since we received content
          emptyTranscriptCount = 0; 
          
          logger.flow('RECV', 'Speechmatics', `AddTranscript with content: "${transcript.substring(0, 30)}${transcript.length > 30 ? '...' : ''}"`);
          
          // Update speech detection status
          ws.send(JSON.stringify({
            type: 'status',
            status: 'speechDetected',
            message: 'Speech detected'
          }));
          
          // Send transcript to client with final flag
          ws.send(JSON.stringify({
            type: 'transcript',
            text: transcript,
            isFinal: true,
            source: 'speechmatics'
          }));
          
          // Update the last time we detected speech
          lastSpeechTime = new Date();
          
          // Add to transcript buffer (since we're only processing final transcripts now)
          transcriptBuffer.push(transcript);
          logger.flow('PROC', 'Server', `Added to buffer: "${transcript.substring(0, 30)}${transcript.length > 30 ? '...' : ''}"`);
          logger.flow('PROC', 'Server', `Buffer size: ${transcriptBuffer.length} segments`);
          
          // Reset any existing silence timer
          if (silenceTimer) {
            logger.flow('PROC', 'Server', 'Resetting silence timer - new speech detected');
            clearTimeout(silenceTimer);
          }
          
          // Reset auto-shutoff timer
          if (autoShutoffTimer) {
            logger.flow('PROC', 'Server', 'Resetting auto-shutoff timer - new speech detected');
            clearTimeout(autoShutoffTimer);
          }
          
          // Start a new silence timer as fallback
          logger.flow('PROC', 'Server', `Starting silence timer (${SILENCE_THRESHOLD}ms)`);
          silenceTimer = setTimeout(() => {
            processFinalTranscriptAndReset('Time-based silence detection');
          }, SILENCE_THRESHOLD);
          
          // Start a new auto-shutoff timer
          logger.flow('PROC', 'Server', `Starting auto-shutoff timer (${AUTO_SHUTOFF_THRESHOLD}ms)`);
          autoShutoffTimer = setTimeout(triggerAutoShutoff, AUTO_SHUTOFF_THRESHOLD);
        } else {
          // Empty transcript handling
          emptyTranscriptCount++;
          logger.flow('PROC', 'Server', `Empty transcript received (no action)`);
          
          // Empty transcript detection logic
          if (transcriptBuffer.length > 0 && emptyTranscriptCount >= EMPTY_TRANSCRIPT_THRESHOLD) {
            logger.flow('PROC', 'Server', `Empty transcript threshold reached (${emptyTranscriptCount}). Processing as silence.`);
            processFinalTranscriptAndReset('Empty transcript silence detection');
          }
        }
      }
      
/*      // Handle partial transcripts
      if (response.message === 'AddPartialTranscript') {
        const transcript = response.metadata.transcript;
        
        // Only log and send non-empty transcripts
        if (transcript.trim().length > 0) {
          logger.debug(`Speechmatics PARTIAL transcript: "${transcript}"`);
          
          // Update status only for non-empty transcripts
          ws.send(JSON.stringify({
            type: 'status',
            status: 'speechDetected',
            message: 'Speech detected'
          }));
          
          // Send to client as a partial transcript
          ws.send(JSON.stringify({
            type: 'transcript',
            text: transcript,
            isFinal: false,
            source: 'speechmatics'
          }));
        }
      }
        */
    } catch (error) {
      logger.error('Error parsing Speechmatics message: ' + error.message, error);
      logger.debug('Raw message: ' + speechmaticsMessage);
    }
  }

  /**
   * Establishes a connection to the Speechmatics API
   */
  function connectToSpeechmatics() {
    // Initialize Speechmatics WebSocket connection
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
      logger.flow('PROC', 'Speechmatics', 'Connection established');
      
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
          enable_partials: false,
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
      
      // Set up auto-shutoff timer
      if (autoShutoffTimer) {
        clearTimeout(autoShutoffTimer);
      }
      logger.flow('PROC', 'Server', `Starting auto-shutoff timer (${AUTO_SHUTOFF_THRESHOLD}ms)`);
      autoShutoffTimer = setTimeout(triggerAutoShutoff, AUTO_SHUTOFF_THRESHOLD);
      
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
      
      logger.flow('SEND', 'Speechmatics', 'StartRecognition');
      speechmaticsWs.send(JSON.stringify(config));
    });
    
    // Attach the unified message handler
    speechmaticsWs.on('message', handleSpeechmaticsMessage);
    
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
  }

  /**
   * Properly closes Speechmatics connection
   * @returns {Promise} Promise that resolves when cleanup is complete
   */
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
        
        // Clear any auto-shutoff timer
        if (autoShutoffTimer) {
          clearTimeout(autoShutoffTimer);
          autoShutoffTimer = null;
        }
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
          logger.flow('SEND', 'Speechmatics', `EndOfStream (last_seq_no: ${lastSeqNo})`);
          speechmaticsWs.send(JSON.stringify(endOfStreamCommand));
          
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
        
        // Clear any auto-shutoff timer
        if (autoShutoffTimer) {
          clearTimeout(autoShutoffTimer);
          autoShutoffTimer = null;
        }
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
          
          // Clear any auto-shutoff timer
          if (autoShutoffTimer) {
            clearTimeout(autoShutoffTimer);
            autoShutoffTimer = null;
          }
          logger.info('Speechmatics connection cleanup complete from close event');
          
          // Remove all listeners from the old WebSocket to avoid memory leaks
          originalWs.removeAllListeners();
          
          resolve();
        });
      }
    });
  }

  // Client WebSocket message handler
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
      logger.debug('Received "start" message from client.');

      // Check 1: WebSocket object exists and is not in a CLOSED state
      if (speechmaticsWs && speechmaticsWs.readyState !== WebSocket.CLOSED) {
        logger.warn('Start command ignored: Speechmatics WebSocket exists and is not closed (state: %s).', speechmaticsWs.readyState);
        ws.send(JSON.stringify({
          type: 'info',
          text: `Speechmatics session is already active or not fully terminated (state: ${speechmaticsWs.readyState}). Please wait or stop the current session.`
        }));
        return; // Crucial: exit if this condition is met
      }
      
      // Check 2: A connection attempt is flagged as in progress
      if (speechmaticsConnecting) {
        logger.warn('Start command ignored: Speechmatics connection attempt already in progress.');
        ws.send(JSON.stringify({
          type: 'info',
          text: 'Speechmatics connection attempt is already in progress. Please wait.'
        }));
        return; // Crucial: exit if this condition is met
      }
      
      // Check 3: Speechmatics API key validity
      // The variable 'speechmaticsKeyValid' is not defined in the provided code.
      // This check makes it safer.
      if (typeof speechmaticsKeyValid !== 'undefined') {
        if (!speechmaticsKeyValid) {
          logger.error('Start command ignored: Speechmatics API key (speechmaticsKeyValid) is defined but invalid (false).');
          ws.send(JSON.stringify({
            type: 'error',
            text: 'Speechmatics API key is invalid. Cannot start session.'
          }));
          return; // Crucial: exit if API key is invalid
        }
        // If speechmaticsKeyValid is true, proceed
      } else {
        // speechmaticsKeyValid is undefined. This is a configuration issue.
        // Depending on policy, you might allow or disallow connection.
        // For stricter behavior, treat as an error.
        logger.error('Start command blocked: Speechmatics API key status (speechmaticsKeyValid) is unknown (variable undefined).');
        ws.send(JSON.stringify({
          type: 'error',
          text: 'Speechmatics API key status is unknown. Please check server configuration. Cannot start session.'
        }));
        return; // Crucial: exit if API key status is unknown
      }
      
      // If all checks above passed (i.e., no early return), proceed to connect.
      logger.info('All checks passed for "start" command. Initiating Speechmatics connection.');
      connectToSpeechmatics();
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
          // Only log occasionally to avoid spamming logs
          if (Math.random() < 0.005) { // Only log ~0.5% of audio chunks
            logger.flow('SEND', 'Speechmatics', `AddAudio (${audioArray.length} samples)`);
          }
          speechmaticsWs.send(audioArray.buffer);
        } catch (error) {
          logger.error('Error sending audio data: ' + error.message, error);
        }
      }
    } else if (data.type === 'stop') {
      // Send EndOfStream to properly close the sequence - ONLY on explicit stop
      if (speechmaticsWs && speechmaticsWs.readyState === WebSocket.OPEN) {
        try {
          const endOfStreamCommand = {
            message: 'EndOfStream',
            last_seq_no: lastSeqNo
          };
          logger.flow('SEND', 'Speechmatics', `EndOfStream (last_seq_no: ${lastSeqNo})`);
          speechmaticsWs.send(JSON.stringify(endOfStreamCommand));
        } catch (error) {
          logger.error(`Error sending EndOfStream during stop: ${error.message}`);
        }
      }
      
      // If we have any pending transcripts in the buffer, send them now
      if (transcriptBuffer.length > 0) {
        // Clear any pending silence timer
        if (silenceTimer) {
          clearTimeout(silenceTimer);
          silenceTimer = null;
        }
        
        await processFinalTranscriptAndReset('Stop button pressed');
      }
      
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
      
      // Clear auto-shutoff timer
      if (autoShutoffTimer) {
        clearTimeout(autoShutoffTimer);
        autoShutoffTimer = null;
      }
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