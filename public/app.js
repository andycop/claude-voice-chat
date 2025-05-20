document.addEventListener('DOMContentLoaded', () => {
    // DOM elements
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const statusElement = document.getElementById('status');
    const speechStatusElement = document.getElementById('speechStatus');
    const apiStatusElement = document.getElementById('apiStatus');
    const claudeStatusElement = document.getElementById('claudeStatus');
    const conversationElement = document.getElementById('conversation');
    const transcriptElement = document.getElementById('transcript');
    const audioVisualizer = document.getElementById('audioVisualizer');
    
    // WebSocket connection
    let ws = null;
    
    // Transcript tracking
    let latestPartialTranscript = '';
    let finalTranscripts = [];
    
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
                console.log(`Received ${transcriptType} transcript from ${transcriptSource}: "${text}"`);
                
                // Update transcript tracking
                if (isFinal) {
                    // Store final transcript
                    finalTranscripts.push(text);
                    latestPartialTranscript = ''; // Reset partial
                    
                    // Update UI with final transcript
                    const html = `
                        <div class="final-transcript-container">
                            <span class="final-transcript">${text}</span>
                        </div>
                        <div class="partial-transcript-container">
                            <span class="partial-transcript">${latestPartialTranscript}</span>
                        </div>
                    `;
                    transcriptElement.innerHTML = html;
                    
                    // Add to conversation
                    addMessageToConversation('user', text);
                } else {
                    // Update latest partial transcript
                    latestPartialTranscript = text;
                    
                    // Show both final and partial transcripts
                    let html = '';
                    
                    // Add the most recent final transcript if it exists
                    if (finalTranscripts.length > 0) {
                        const recentFinal = finalTranscripts[finalTranscripts.length - 1];
                        html += `
                            <div class="final-transcript-container">
                                <span class="final-transcript">${recentFinal}</span>
                            </div>
                        `;
                    }
                    
                    // Add the current partial transcript
                    html += `
                        <div class="partial-transcript-container">
                            <span class="partial-transcript">${latestPartialTranscript}</span>
                        </div>
                    `;
                    
                    transcriptElement.innerHTML = html;
                }
            } else if (message.type === 'response') {
                // Add Claude's response to conversation
                addMessageToConversation('assistant', message.text);
                // Clear transcript after processing
                transcriptElement.textContent = '';
            } else if (message.type === 'error') {
                console.error('Error:', message.text);
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
    function addMessageToConversation(role, text) {
        // Remove welcome message if present
        const welcomeMessage = conversationElement.querySelector('.welcome-message');
        if (welcomeMessage) {
            welcomeMessage.remove();
        }
        
        // Create message element
        const messageElement = document.createElement('div');
        messageElement.className = `message ${role}-message`;
        
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
            latestPartialTranscript = '';
            finalTranscripts = [];
            transcriptElement.innerHTML = '';
            
            // Get user media
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            // Create audio context
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            
            // Create media recorder
            mediaRecorder = new MediaRecorder(mediaStream);
            
            // Create script processor for audio processing
            const sourceNode = audioContext.createMediaStreamSource(mediaStream);
            audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
            
            // Set up audio analyzer for visualization
            audioAnalyser = audioContext.createAnalyser();
            audioAnalyser.fftSize = 256;
            const bufferLength = audioAnalyser.frequencyBinCount;
            audioDataArray = new Uint8Array(bufferLength);
            
            // Connect nodes
            sourceNode.connect(audioAnalyser);
            audioAnalyser.connect(audioProcessor);
            sourceNode.connect(audioProcessor);
            audioProcessor.connect(audioContext.destination);
            
            // Start audio visualizer
            drawAudioVisualizer();
            
            // Process audio data
            audioProcessor.onaudioprocess = (e) => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    // Get audio data
                    const inputData = e.inputBuffer.getChannelData(0);
                    
                    // Convert float32 to int16
                    const int16Array = new Int16Array(inputData.length);
                    for (let i = 0; i < inputData.length; i++) {
                        int16Array[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
                    }
                    
                    // Send audio data to server
                    ws.send(JSON.stringify({
                        type: 'audio',
                        audio: Array.from(int16Array)
                    }));
                }
            };
            
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
    
    // Event listeners
    startBtn.addEventListener('click', startRecording);
    stopBtn.addEventListener('click', stopRecording);
    document.getElementById('debugBtn').addEventListener('click', debugClaudeStatus);
    
    // Connect to server when page loads
    connectWebSocket();
});