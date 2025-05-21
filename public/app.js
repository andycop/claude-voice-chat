document.addEventListener('DOMContentLoaded', () => {
    // DOM elements - New UI
    const listeningBtn = document.getElementById('listeningBtn');
    const recordingBtn = document.getElementById('recordingBtn');
    const recordingInfoElement = document.getElementById('recordingInfo');
    const microphoneSelect = document.getElementById('microphoneSelect');
    const transcriptElement = document.getElementById('transcript');
    const conversationElement = document.getElementById('conversation');
    const audioVisualizer = document.getElementById('audioVisualizer');
    
    // Legacy elements (hidden but still used by original code)
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const startRecordingBtn = document.getElementById('startRecordingBtn');
    const stopRecordingBtn = document.getElementById('stopRecordingBtn');
    const debugBtn = document.getElementById('debugBtn');
    
    // Status elements - new UI uses dots instead of text
    const connectionStatusDot = document.querySelector('#connection-status .status-dot');
    const speechStatusDot = document.querySelector('#speech-status .status-dot');
    const apiStatusDot = document.querySelector('#api-status .status-dot');
    const claudeStatusDot = document.querySelector('#claude-status .status-dot');
    
    // Track listening state
    let isListening = false;
    let isRecordingAudio = false;
    
    // WebSocket connection
    let ws = null;
    
    // Transcript tracking for showing current speech segment
    let finalTranscripts = [];
    let accumulatedTranscripts = [];
    
    // Audio visualizer
    let audioVisualizerContext = audioVisualizer.getContext('2d');
    let audioAnalyser = null;
    let audioDataArray = null;
    let animationFrameId = null;
    
    // Audio context and processing
    let audioContext = null;
    let mediaStream = null;
    let mediaRecorder = null;
    let audioProcessor = null;
    
    // Audio recording state
    let isRecording = false;
    let recordingStartTime = null;
    let recordingTimer = null;
    
    // Function to establish WebSocket connection
    function connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;
        
        ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
            console.log('Connected to server');
            updateStatus('connection', 'Connected');
            listeningBtn.disabled = false;
            
            // Initialize all other statuses
            updateStatus('speech', 'Inactive');
            updateStatus('api', 'Inactive');
            updateStatus('claude', 'Inactive');
        };
        
        ws.onclose = () => {
            console.log('Disconnected from server');
            updateStatus('connection', 'Disconnected');
            updateStatus('speech', 'Inactive');
            updateStatus('api', 'Inactive');
            updateStatus('claude', 'Inactive');
            listeningBtn.disabled = false;
            
            // Stop audio visualizer if active
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
            
            // Reset listening button state
            setListeningState(false);
        };
        
        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            updateStatus('connection', 'Error');
        };
        
        ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            
            if (message.type === 'status') {
                handleStatusUpdate(message);
            } else if (message.type === 'transcript') {
                // Get transcript details
                const { text, isFinal, source } = message;
                
                // Format the transcript with type indication
                const transcriptType = isFinal ? 'final' : 'partial';
                const transcriptSource = source || 'unknown';
                
                // Add transcript to console for debugging
                console.log(`Received individual ${transcriptType} transcript from ${transcriptSource}: "${text}"`);
                
                // Store final transcript with timestamp
                const timestamp = new Date().toLocaleTimeString();
                
                // For partial transcripts or final fragments, we're building a sentence
                // Update timestamp for this fragment
                const segment = { text, timestamp, isFinal };
                
                // If this is the first transcript or a final transcript after partials
                if (accumulatedTranscripts.length === 0 || isFinal) {
                    accumulatedTranscripts.push(segment);
                } else {
                    // Replace the last partial transcript with the new one (we're receiving updated partials)
                    if (!accumulatedTranscripts[accumulatedTranscripts.length - 1].isFinal) {
                        accumulatedTranscripts[accumulatedTranscripts.length - 1] = segment;
                    } else {
                        // If last segment was final, add this as a new segment
                        accumulatedTranscripts.push(segment);
                    }
                }
                
                // Display all fragments as a flowing sentence, not separate items
                let displayText = '';
                accumulatedTranscripts.forEach(item => {
                    displayText += item.text + ' ';
                });
                
                // Remove extra spaces
                displayText = displayText.trim();
                
                // Update UI with current sentence being built
                transcriptElement.innerHTML = `
                    <div class="current-transcript-container">
                        <span class="current-transcript">${displayText}</span>
                    </div>
                `;
                
                // We don't add individual transcripts to the conversation anymore,
                // as we'll show the complete sentences from completeTranscript messages
            } else if (message.type === 'completeTranscript') {
                // Get the complete transcript (after silence detection or EndOfTranscript)
                // This represents the end of a logical sentence
                const { text, isFinal, source } = message;
                
                console.log(`Received COMPLETE transcript to send to Claude: "${text}"`);
                
                // Add the complete transcript to the conversation
                addMessageToConversation('user', text, false); // false = permanent message
                
                // Clear the accumulated transcripts display since we've now got the complete sentence
                // and we're starting a new sentence
                accumulatedTranscripts = [];
                transcriptElement.innerHTML = '';
            } else if (message.type === 'response') {
                // Add Claude's response to conversation
                addMessageToConversation('assistant', message.text);
                // Clear transcript and accumulated transcripts after receiving Claude's response
                transcriptElement.textContent = '';
                accumulatedTranscripts = [];
            } else if (message.type === 'audioRecorded') {
                // Add download link for recorded audio
                const { filePath, duration } = message;
                
                // Format duration to show minutes and seconds
                const durationMinutes = Math.floor(duration / 60);
                const durationSeconds = Math.floor(duration % 60);
                const formattedDuration = `${durationMinutes}:${durationSeconds.toString().padStart(2, '0')}`;
                
                const infoElement = document.createElement('div');
                infoElement.className = 'info-message';
                infoElement.innerHTML = `Audio recording saved (${formattedDuration})<br/>
                    <a href="${filePath}" class="download-link" download>Download WAV File</a>`;
                
                // Add info to conversation
                conversationElement.appendChild(infoElement);
                
                // Scroll to bottom
                conversationElement.scrollTop = conversationElement.scrollHeight;
                
                // Update recording info
                recordingInfoElement.textContent = `Latest recording: ${formattedDuration} (see conversation for download link)`;
                recordingInfoElement.classList.add('active');
                
                // Reset recording state
                setRecordingState(false);
            } else if (message.type === 'error') {
                console.error('Error:', message.text);
                
                // Display error in the UI instead of using an alert
                const errorElement = document.createElement('div');
                errorElement.className = 'error-message';
                errorElement.textContent = message.text;
                
                // Add error to conversation
                conversationElement.appendChild(errorElement);
                
                // Scroll to bottom
                conversationElement.scrollTop = conversationElement.scrollHeight;
                
                // Stop recording if it's a critical error
                if (message.text.includes('API key') || 
                    message.text.includes('authorization') || 
                    message.text.includes('timed out')) {
                    stopRecording();
                }
                
                // Stop audio recording if there's an error with it
                if (message.text.includes('audio recording')) {
                    setRecordingState(false);
                }
            } else if (message.type === 'info') {
                console.log('Info:', message.text);
                
                // Display info in the UI
                const infoElement = document.createElement('div');
                infoElement.className = 'info-message';
                infoElement.textContent = message.text;
                
                // Add info to conversation
                conversationElement.appendChild(infoElement);
                
                // Scroll to bottom
                conversationElement.scrollTop = conversationElement.scrollHeight;
            }
        };
        
        // Function to handle status updates
        function handleStatusUpdate(message) {
            console.log('Status update received:', message.status, message.message);
            
            switch (message.status) {
                // Connection status updates
                case 'connected':
                    updateStatus('connection', 'Connected');
                    break;
                    
                // Speech detection status updates
                case 'speechDetected':
                    updateStatus('speech', 'Active');
                    break;
                    
                // API status updates
                case 'apiConnecting':
                    updateStatus('api', 'Connecting', 'pending');
                    break;
                case 'apiConnected':
                    updateStatus('api', 'Connected');
                    break;
                case 'apiProcessing':
                    updateStatus('api', 'Processing', 'active');
                    break;
                case 'apiError':
                    updateStatus('api', 'Error');
                    stopRecording(); // Stop recording on API error
                    break;
                case 'apiRetrying':
                    updateStatus('api', 'Retrying', 'pending');
                    break;
                case 'apiFinalTranscript':
                    updateStatus('api', 'Final Transcript', 'active');
                    break;
                    
                // Claude status updates
                case 'claudeProcessing':
                    updateStatus('claude', 'Processing', 'pending');
                    break;
                case 'claudeResponded':
                    updateStatus('claude', 'Responded', 'active');
                    break;
                case 'claudeWaiting':
                    updateStatus('claude', 'Waiting', 'active');
                    break;
                case 'claudeError':
                    updateStatus('claude', 'Error');
                    break;
            }
        }
    }
    
    // Function to add message to conversation
    function addMessageToConversation(role, text, isTemporary = false) {
        // Remove welcome message if present
        const welcomeMessage = conversationElement.querySelector('.welcome-message');
        if (welcomeMessage) {
            welcomeMessage.remove();
        }
        
        // If this is temporary and from the user (part of current speech), 
        // we want to update the last message instead of adding a new one
        if (isTemporary && role === 'user') {
            // Find the last user message
            const lastUserMessage = conversationElement.querySelector('.user-message:last-child');
            
            if (lastUserMessage && lastUserMessage.dataset.temporary === 'true') {
                // Replace text content
                const textElement = lastUserMessage.querySelector('p');
                if (textElement) {
                    textElement.textContent = text;
                    // Scroll to bottom
                    conversationElement.scrollTop = conversationElement.scrollHeight;
                    return;
                }
            }
        }
        
        // Create message element
        const messageElement = document.createElement('div');
        messageElement.className = `message ${role}-message`;
        if (isTemporary) {
            messageElement.dataset.temporary = 'true';
        }
        
        // Add text - parse markdown for assistant responses
        if (role === 'assistant' && typeof marked !== 'undefined') {
            try {
                // Configure Marked.js options
                marked.setOptions({
                    breaks: true,          // Add <br> on single line breaks
                    gfm: true,             // Use GitHub Flavored Markdown
                    headerIds: false,      // Don't add ids to headers
                    mangle: false,         // Don't mangle email links
                    sanitize: false,       // Don't sanitize HTML (marked handles this)
                });
                
                // Parse the markdown and set the HTML content
                messageElement.innerHTML = marked.parse(text);
                
                // Make links open in a new tab for safety
                const links = messageElement.querySelectorAll('a');
                links.forEach(link => {
                    link.setAttribute('target', '_blank');
                    link.setAttribute('rel', 'noopener noreferrer');
                });
                
                console.log('Rendered markdown for Claude response');
            } catch (error) {
                console.error('Error parsing markdown:', error);
                
                // Fallback to plain text if markdown parsing fails
                const textElement = document.createElement('p');
                textElement.textContent = text;
                messageElement.appendChild(textElement);
            }
        } else {
            // Regular text for user messages
            const textElement = document.createElement('p');
            textElement.textContent = text;
            messageElement.appendChild(textElement);
        }
        
        // Add to conversation
        conversationElement.appendChild(messageElement);
        
        // Scroll to bottom
        conversationElement.scrollTop = conversationElement.scrollHeight;
    }
    
    // Function to update status indicators
    function updateStatus(type, status, statusClass = '') {
        let dot;
        
        switch (type) {
            case 'connection':
                dot = connectionStatusDot;
                break;
            case 'speech':
                dot = speechStatusDot;
                break;
            case 'api':
                dot = apiStatusDot;
                break;
            case 'claude':
                dot = claudeStatusDot;
                break;
            default:
                return;
        }
        
        // Clear existing classes and add active if needed
        dot.className = 'status-dot';
        
        if (status === 'Connected' || status === 'Active' || status === 'Ready' || status === 'Waiting' || status === 'Responded') {
            dot.classList.add('active');
        } else if (status === 'Processing' || status === 'Connecting' || status === 'Retrying' || status === 'Final Transcript') {
            // For pending statuses, add a pulse animation via CSS
            dot.classList.add('active');
            dot.style.opacity = '0.7';
        } else {
            // Error or inactive status
            dot.style.opacity = '1';
        }
        
        // Also update the legacy status elements for backward compatibility
        updateLegacyStatus(type, status, statusClass);
    }
    
    // Update legacy status elements for backward compatibility
    function updateLegacyStatus(type, status, statusClass = '') {
        let element;
        
        switch (type) {
            case 'connection':
                element = document.getElementById('status');
                break;
            case 'speech':
                element = document.getElementById('speechStatus');
                break;
            case 'api':
                element = document.getElementById('apiStatus');
                break;
            case 'claude':
                element = document.getElementById('claudeStatus');
                break;
            default:
                return;
        }
        
        if (element) {
            element.textContent = status;
            
            // Reset classes
            element.className = '';
            
            // Add status class if provided, otherwise determine based on status
            if (statusClass) {
                element.classList.add(`status-${statusClass}`);
            } else if (status === 'Connected' || status === 'Active' || status === 'Ready') {
                element.classList.add('status-active');
            } else if (status === 'Processing' || status === 'Connecting') {
                element.classList.add('status-pending');
            }
        }
    }
    
    // Function to draw audio visualizer
    function drawAudioVisualizer() {
        // Clear canvas
        audioVisualizerContext.clearRect(0, 0, audioVisualizer.width, audioVisualizer.height);
        
        if (audioAnalyser) {
            // Get audio data
            audioAnalyser.getByteFrequencyData(audioDataArray);
            
            // Draw bars horizontally with colorful gradient
            const barWidth = (audioVisualizer.width / audioDataArray.length) * 1.5;
            let x = 0;
            
            // Create gradient background pattern
            const gradient = audioVisualizerContext.createLinearGradient(0, 0, audioVisualizer.width, 0);
            gradient.addColorStop(0, "#8844ee");    // Purple
            gradient.addColorStop(0.2, "#2b9df8");  // Blue
            gradient.addColorStop(0.4, "#28e266");  // Green
            gradient.addColorStop(0.6, "#ffde17");  // Yellow
            gradient.addColorStop(0.8, "#ff8c44");  // Orange
            gradient.addColorStop(1, "#f94169");    // Red
            
            for (let i = 0; i < audioDataArray.length; i++) {
                const barHeight = (audioDataArray[i] / 255) * audioVisualizer.height * 0.8;
                
                // Calculate position for centered bars
                const yPos = (audioVisualizer.height - barHeight) / 2;
                
                // Use a different hue for each bar to create a rainbow effect
                const colorPosition = i / audioDataArray.length;
                audioVisualizerContext.fillStyle = gradient;
                
                // Draw with rounded corners if supported, otherwise use regular rectangles
                if (audioVisualizerContext.roundRect) {
                    audioVisualizerContext.beginPath();
                    audioVisualizerContext.roundRect(
                        x, 
                        yPos, 
                        Math.max(barWidth - 1, 1), // Ensure bars have at least 1px width
                        barHeight,
                        2 // Corner radius
                    );
                    audioVisualizerContext.fill();
                } else {
                    // Fallback for browsers that don't support roundRect
                    audioVisualizerContext.fillRect(
                        x, 
                        yPos, 
                        Math.max(barWidth - 1, 1),
                        barHeight
                    );
                }
                
                x += barWidth;
            }
            
            // If any significant audio detected, update speech status
            const sum = audioDataArray.reduce((a, b) => a + b, 0);
            const average = sum / audioDataArray.length;
            
            if (average > 20) {
                updateStatus('speech', 'Active', 'active');
            } else {
                updateStatus('speech', 'Listening');
            }
        }
        
        // Continue animation
        animationFrameId = requestAnimationFrame(drawAudioVisualizer);
    }
    
    // Function to initialize audio recording
    async function startRecording() {
        try {
            // Reset transcript tracking
            finalTranscripts = [];
            accumulatedTranscripts = [];
            transcriptElement.innerHTML = '';
            
            // Get the selected microphone device ID
            const selectedDeviceId = microphoneSelect.value;
            
            // Configure audio constraints
            let audioConstraints = { audio: true }; // Default to system default
            
            // If a specific microphone is selected (not 'default'), use its device ID
            if (selectedDeviceId && selectedDeviceId !== 'default') {
                audioConstraints = {
                    audio: {
                        deviceId: { exact: selectedDeviceId }
                    }
                };
                console.log(`Using selected microphone: ${selectedDeviceId}`);
            } else {
                console.log('Using default microphone');
            }
            
            // Get user media with the selected microphone
            mediaStream = await navigator.mediaDevices.getUserMedia(audioConstraints);
            
            // Now that we have permission, populate the microphone list if it wasn't already
            // This ensures we get proper device labels
            if (!microphoneSelect.options.length || microphoneSelect.options[0].value === '') {
                await populateMicrophoneList();
            }
            
            // Create audio context
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            
            // Create media recorder
            mediaRecorder = new MediaRecorder(mediaStream);
            
            // Create source node and audio analyzer for visualization
            const sourceNode = audioContext.createMediaStreamSource(mediaStream);
            audioAnalyser = audioContext.createAnalyser();
            audioAnalyser.fftSize = 256;
            const bufferLength = audioAnalyser.frequencyBinCount;
            audioDataArray = new Uint8Array(bufferLength);
            
            // Connect the analyzer for visualizations
            sourceNode.connect(audioAnalyser);
            
            // Check if AudioWorklet is supported
            if (audioContext.audioWorklet) {
                console.log('Using AudioWorklet for audio processing');
                
                try {
                    // Load and initialize the audio worklet
                    await audioContext.audioWorklet.addModule('audio-processor.js');
                    
                    // Create the AudioWorkletNode
                    audioProcessor = new AudioWorkletNode(audioContext, 'audio-sample-processor');
                    
                    // Connect the source to the processor
                    sourceNode.connect(audioProcessor);
                    audioProcessor.connect(audioContext.destination);
                    
                    // Set up message handler for processed audio data
                    audioProcessor.port.onmessage = (event) => {
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            // Get audio data from the worklet
                            const int16Array = event.data.audio;
                            const actualSampleRate = event.data.sampleRate || 16000;
                            
                            // Log sample rate only once for debugging
                            if (!audioProcessor.sampleRateLogged) {
                                console.log(`Sending audio with sample rate: ${actualSampleRate}Hz`);
                                audioProcessor.sampleRateLogged = true;
                            }
                            
                            // Send audio data to server
                            ws.send(JSON.stringify({
                                type: 'audio',
                                audio: Array.from(int16Array),
                                encoding: 'pcm_s16le',
                                sample_rate: actualSampleRate
                            }));
                        }
                    };
                } catch (workletError) {
                    console.error('AudioWorklet failed to initialize:', workletError);
                    console.log('Falling back to ScriptProcessor');
                    useScriptProcessor(sourceNode);
                }
            } else {
                console.log('AudioWorklet not supported, falling back to ScriptProcessor');
                useScriptProcessor(sourceNode);
            }
            
            // Start audio visualizer
            drawAudioVisualizer();
            
            // Function to use ScriptProcessor as fallback
            function useScriptProcessor(sourceNode) {
                // Create script processor for audio processing
                audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
                
                // Connect nodes
                sourceNode.connect(audioProcessor);
                audioProcessor.connect(audioContext.destination);
                
                // Get the sample rate
                const currentSampleRate = audioContext.sampleRate;
                const targetSampleRate = 16000; // 16kHz
                const resampleRatio = targetSampleRate / currentSampleRate;
                
                console.log(`ScriptProcessor: Resampling from ${currentSampleRate}Hz to ${targetSampleRate}Hz (ratio: ${resampleRatio})`);
                
                // Simple resampling function
                function resampleAudio(samples, ratio) {
                    // If sample rates match, no resampling needed
                    if (ratio === 1) return samples;
                    
                    // Calculate how many output samples we'll generate
                    const outputLength = Math.floor(samples.length * ratio);
                    const output = new Float32Array(outputLength);
                    
                    // Downsampling from higher rate to lower rate
                    if (ratio < 1) {
                        // Simple averaging for downsampling
                        for (let i = 0; i < outputLength; i++) {
                            const srcIndex = Math.floor(i / ratio);
                            output[i] = samples[srcIndex];
                        }
                    }
                    // Upsampling from lower rate to higher rate
                    else {
                        // Linear interpolation for upsampling
                        for (let i = 0; i < outputLength; i++) {
                            const srcIndex = i / ratio;
                            const srcIndexFloor = Math.floor(srcIndex);
                            const srcIndexCeil = Math.min(samples.length - 1, srcIndexFloor + 1);
                            const t = srcIndex - srcIndexFloor; // Interpolation factor
                            
                            // Linear interpolation between two nearest samples
                            output[i] = (1 - t) * samples[srcIndexFloor] + t * samples[srcIndexCeil];
                        }
                    }
                    
                    return output;
                }
                
                // Flag to track if we've logged the sample rate
                let sampleRateLogged = false;
                
                // Process audio data
                audioProcessor.onaudioprocess = (e) => {
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        // Get audio data
                        const inputData = e.inputBuffer.getChannelData(0);
                        
                        // Resample to 16kHz
                        const resampledData = resampleAudio(inputData, resampleRatio);
                        
                        // Convert float32 to int16
                        const int16Array = new Int16Array(resampledData.length);
                        for (let i = 0; i < resampledData.length; i++) {
                            int16Array[i] = Math.max(-32768, Math.min(32767, resampledData[i] * 32768));
                        }
                        
                        // Log sample rate only once for debugging
                        if (!sampleRateLogged) {
                            console.log(`Sending audio with sample rate: ${targetSampleRate}Hz from ScriptProcessor`);
                            sampleRateLogged = true;
                        }
                        
                        // Send audio data to server
                        ws.send(JSON.stringify({
                            type: 'audio',
                            audio: Array.from(int16Array),
                            encoding: 'pcm_s16le',
                            sample_rate: targetSampleRate
                        }));
                    }
                };
            }
            
            // Start recording
            mediaRecorder.start();
            
            // Tell server we're starting
            ws.send(JSON.stringify({ type: 'start' }));
            
            // Update UI
            updateStatus('connection', 'Listening', 'active');
            updateStatus('speech', 'Listening');
            updateStatus('api', 'Connecting', 'pending');
            updateStatus('claude', 'Waiting', 'active');
            
            // Update legacy button states for compatibility
            startBtn.disabled = true;
            stopBtn.disabled = false;
        } catch (error) {
            console.error('Error starting recording:', error);
            alert('Failed to access microphone. Please ensure it is connected and that you have granted permission.');
            setListeningState(false);
        }
    }
    
    // Function to stop recording
    function stopRecording() {
        // Tell server we're stopping
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'stop' }));
        }
        
        // Stop audio visualizer
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        
        // Stop recording
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        
        // Release resources
        if (audioProcessor) {
            audioProcessor.disconnect();
            
            // Clean up based on type of processor
            if (audioProcessor.port) {
                audioProcessor.port.onmessage = null;
            }
            
            audioProcessor = null;
        }
        
        if (audioAnalyser) {
            audioAnalyser.disconnect();
            audioAnalyser = null;
        }
        
        if (audioContext) {
            audioContext.close();
            audioContext = null;
        }
        
        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }
        
        // Update UI
        updateStatus('connection', 'Connected', 'active');
        updateStatus('speech', 'Inactive');
        updateStatus('api', 'Inactive');
        updateStatus('claude', 'Inactive');
        
        // Clear canvas
        audioVisualizerContext.clearRect(0, 0, audioVisualizer.width, audioVisualizer.height);
        
        // Update legacy button states for compatibility
        startBtn.disabled = false;
        stopBtn.disabled = true;
    }
    
    // Function to toggle listening state
    function toggleListening() {
        if (isListening) {
            // Currently listening, so stop
            stopRecording();
            setListeningState(false);
        } else {
            // Not listening, so start
            startRecording();
            setListeningState(true);
        }
    }
    
    // Update UI based on listening state
    function setListeningState(listening) {
        isListening = listening;
        
        if (listening) {
            listeningBtn.innerHTML = `<i class="fas fa-stop"></i> <span>Stop Listening</span>`;
            listeningBtn.classList.add('active');
        } else {
            listeningBtn.innerHTML = `<i class="fas fa-play"></i> <span>Start Listening</span>`;
            listeningBtn.classList.remove('active');
        }
    }
    
    // Toggle recording state
    function toggleRecording() {
        if (isRecordingAudio) {
            // Currently recording, so stop
            stopRecordingAudio();
            setRecordingState(false);
        } else {
            // Not recording, so start
            startRecordingAudio();
            setRecordingState(true);
        }
    }
    
    // Update UI based on recording state
    function setRecordingState(recording) {
        isRecordingAudio = recording;
        
        if (recording) {
            recordingBtn.classList.add('active');
            recordingBtn.innerHTML = `<i class="fas fa-stop-circle"></i> <span>Stop</span>`;
            // Trigger the legacy button click event
            startRecordingBtn.click();
        } else {
            recordingBtn.classList.remove('active');
            recordingBtn.innerHTML = `<i class="fas fa-record-vinyl"></i> <span>Record</span>`;
            // Trigger the legacy button click event
            stopRecordingBtn.click();
        }
    }
    
    // Debug function to cycle through Claude statuses
    function debugClaudeStatus() {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.log('WebSocket not connected');
            return;
        }
        
        const statuses = [
            'claudeWaiting',
            'claudeProcessing',
            'claudeResponded',
            'apiFinalTranscript'
        ];
        
        // Get current status from the dot's class
        let currentStatus = 'none';
        if (claudeStatusDot.classList.contains('active')) {
            currentStatus = 'claudeWaiting';
        }
        
        const currentIndex = statuses.findIndex(status => status === currentStatus);
        const nextIndex = (currentIndex + 1) % statuses.length;
        const nextStatus = statuses[nextIndex];
        
        console.log('Setting status to:', nextStatus);
        ws.send(JSON.stringify({
            type: 'forceClaudeStatus',
            status: nextStatus,
            message: `Debug: forcing status to ${nextStatus}`
        }));
    }
    
    // Start audio recording
    function startRecordingAudio() {
        isRecording = true;
        recordingStartTime = new Date();
        recordingInfoElement.textContent = 'Recording: 0:00';
        recordingInfoElement.classList.add('active');
        
        // Update timer every second
        recordingTimer = setInterval(updateRecordingTimer, 1000);
        
        // Send command to server
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'startRecording' }));
        }
    }
    
    // Stop audio recording
    function stopRecordingAudio() {
        isRecording = false;
        recordingStartTime = null;
        
        // Clear timer
        if (recordingTimer) {
            clearInterval(recordingTimer);
            recordingTimer = null;
        }
        
        // Send command to server
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'stopRecording' }));
        }
    }
    
    // Recording timer function
    function updateRecordingTimer() {
        if (isRecording && recordingStartTime) {
            const elapsedTime = Math.floor((new Date() - recordingStartTime) / 1000);
            const minutes = Math.floor(elapsedTime / 60);
            const seconds = elapsedTime % 60;
            recordingInfoElement.textContent = `Recording: ${minutes}:${seconds.toString().padStart(2, '0')}`;
        }
    }
    
    // Function to populate microphone dropdown
    async function populateMicrophoneList() {
        try {
            // Get the list of available media devices
            const devices = await navigator.mediaDevices.enumerateDevices();
            
            // Filter for audio input devices (microphones)
            const microphones = devices.filter(device => device.kind === 'audioinput');
            
            // If we have microphones, populate the dropdown
            if (microphones.length > 0) {
                // Clear the loading option
                microphoneSelect.innerHTML = '';
                
                // Add a default option that uses the system default microphone
                const defaultOption = document.createElement('option');
                defaultOption.value = 'default';
                defaultOption.textContent = 'Default Microphone';
                microphoneSelect.appendChild(defaultOption);
                
                // Add each microphone to the dropdown
                microphones.forEach(mic => {
                    const option = document.createElement('option');
                    option.value = mic.deviceId;
                    
                    // Use the device label if available, otherwise use a generic name with the index
                    if (mic.label) {
                        option.textContent = mic.label;
                    } else {
                        option.textContent = `Microphone ${microphoneSelect.options.length}`;
                    }
                    
                    microphoneSelect.appendChild(option);
                });
                
                console.log(`Populated microphone dropdown with ${microphones.length} devices`);
            } else {
                // No microphones found
                const noMicOption = document.createElement('option');
                noMicOption.value = '';
                noMicOption.textContent = 'No microphones found';
                noMicOption.disabled = true;
                microphoneSelect.innerHTML = '';
                microphoneSelect.appendChild(noMicOption);
                
                console.warn('No microphones found');
            }
        } catch (error) {
            console.error('Error enumerating audio devices:', error);
            
            // Set an error message in the dropdown
            const errorOption = document.createElement('option');
            errorOption.value = '';
            errorOption.textContent = 'Error loading microphones';
            errorOption.disabled = true;
            microphoneSelect.innerHTML = '';
            microphoneSelect.appendChild(errorOption);
        }
    }
    
    // Event listeners for new UI
    listeningBtn.addEventListener('click', toggleListening);
    recordingBtn.addEventListener('click', toggleRecording);
    
    // Legacy event listeners (hidden buttons, used for backward compatibility)
    startBtn.addEventListener('click', startRecording);
    stopBtn.addEventListener('click', stopRecording);
    debugBtn.addEventListener('click', debugClaudeStatus);
    
    // Try to populate the microphone list immediately, but this may
    // require permission that we don't have yet
    populateMicrophoneList().catch(err => {
        console.log('Initial microphone list population failed:', err);
        console.log('This is normal if permissions haven\'t been granted yet');
    });
    
    // Connect to server when page loads
    connectWebSocket();
});