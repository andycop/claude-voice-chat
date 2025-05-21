document.addEventListener('DOMContentLoaded', () => {
    // DOM elements
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const startRecordingBtn = document.getElementById('startRecordingBtn');
    const stopRecordingBtn = document.getElementById('stopRecordingBtn');
    const recordingInfoElement = document.getElementById('recordingInfo');
    const statusElement = document.getElementById('status');
    const speechStatusElement = document.getElementById('speechStatus');
    const apiStatusElement = document.getElementById('apiStatus');
    const claudeStatusElement = document.getElementById('claudeStatus');
    const conversationElement = document.getElementById('conversation');
    const transcriptElement = document.getElementById('transcript');
    const audioVisualizer = document.getElementById('audioVisualizer');
    
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
            startBtn.disabled = false;
            
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
            startBtn.disabled = false;
            stopBtn.disabled = true;
            
            // Stop audio visualizer if active
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
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
                
                // Reset recording state
                stopRecordingUI();
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
                    stopRecordingUI();
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
        
        // Add text
        const textElement = document.createElement('p');
        textElement.textContent = text;
        messageElement.appendChild(textElement);
        
        // Add to conversation
        conversationElement.appendChild(messageElement);
        
        // Scroll to bottom
        conversationElement.scrollTop = conversationElement.scrollHeight;
    }
    
    // Function to update status indicators
    function updateStatus(type, status, statusClass = '') {
        let element;
        
        switch (type) {
            case 'connection':
                element = statusElement;
                break;
            case 'speech':
                element = speechStatusElement;
                break;
            case 'api':
                element = apiStatusElement;
                break;
            case 'claude':
                element = claudeStatusElement;
                break;
            default:
                return;
        }
        
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
    
    // Function to draw audio visualizer
    function drawAudioVisualizer() {
        // Clear canvas
        audioVisualizerContext.clearRect(0, 0, audioVisualizer.width, audioVisualizer.height);
        
        if (audioAnalyser) {
            // Get audio data
            audioAnalyser.getByteFrequencyData(audioDataArray);
            
            // Draw bars
            const barWidth = (audioVisualizer.width / audioDataArray.length) * 2.5;
            let x = 0;
            
            for (let i = 0; i < audioDataArray.length; i++) {
                const barHeight = (audioDataArray[i] / 255) * audioVisualizer.height;
                
                // Use gradient color based on frequency
                const hue = (i / audioDataArray.length) * 240;
                audioVisualizerContext.fillStyle = `hsl(${hue}, 100%, 50%)`;
                
                audioVisualizerContext.fillRect(x, audioVisualizer.height - barHeight, barWidth, barHeight);
                
                x += barWidth + 1;
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
            
            // Get user media
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
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
            
            startBtn.disabled = true;
            stopBtn.disabled = false;
        } catch (error) {
            console.error('Error starting recording:', error);
            alert('Failed to access microphone. Please ensure it is connected and that you have granted permission.');
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
        
        startBtn.disabled = false;
        stopBtn.disabled = true;
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
        
        const currentIndex = statuses.findIndex(status => 
            claudeStatusElement.textContent === 'Processing' ? status === 'claudeProcessing' :
            claudeStatusElement.textContent === 'Waiting' ? status === 'claudeWaiting' :
            claudeStatusElement.textContent === 'Responded' ? status === 'claudeResponded' : -1
        );
        
        const nextIndex = (currentIndex + 1) % statuses.length;
        const nextStatus = statuses[nextIndex];
        
        console.log('Setting status to:', nextStatus);
        ws.send(JSON.stringify({
            type: 'forceClaudeStatus',
            status: nextStatus,
            message: `Debug: forcing status to ${nextStatus}`
        }));
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
    
    // Start audio recording UI update
    function startRecordingUI() {
        isRecording = true;
        recordingStartTime = new Date();
        startRecordingBtn.disabled = true;
        stopRecordingBtn.disabled = false;
        recordingInfoElement.textContent = 'Recording: 0:00';
        
        // Update timer every second
        recordingTimer = setInterval(updateRecordingTimer, 1000);
        
        // Send command to server
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'startRecording' }));
        }
    }
    
    // Stop audio recording UI update
    function stopRecordingUI() {
        isRecording = false;
        recordingStartTime = null;
        startRecordingBtn.disabled = false;
        stopRecordingBtn.disabled = true;
        
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
    
    // Event listeners
    startBtn.addEventListener('click', startRecording);
    stopBtn.addEventListener('click', stopRecording);
    startRecordingBtn.addEventListener('click', startRecordingUI);
    stopRecordingBtn.addEventListener('click', stopRecordingUI);
    document.getElementById('debugBtn').addEventListener('click', debugClaudeStatus);
    
    // Connect to server when page loads
    connectWebSocket();
});