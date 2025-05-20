document.addEventListener('DOMContentLoaded', () => {
    // DOM elements
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const statusElement = document.getElementById('status');
    const conversationElement = document.getElementById('conversation');
    const transcriptElement = document.getElementById('transcript');
    
    // WebSocket connection
    let ws = null;
    
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
            statusElement.textContent = 'Connected';
            statusElement.className = 'connected';
            startBtn.disabled = false;
        };
        
        ws.onclose = () => {
            console.log('Disconnected from server');
            statusElement.textContent = 'Disconnected';
            statusElement.className = '';
            startBtn.disabled = false;
            stopBtn.disabled = true;
        };
        
        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            statusElement.textContent = 'Error';
        };
        
        ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            
            if (message.type === 'transcript') {
                // Update transcript
                transcriptElement.textContent = message.text;
                
                // Add user message to conversation if final
                if (message.isFinal) {
                    addMessageToConversation('user', message.text);
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
    
    // Function to initialize audio recording
    async function startRecording() {
        try {
            // Get user media
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            // Create audio context
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            
            // Create media recorder
            mediaRecorder = new MediaRecorder(mediaStream);
            
            // Create script processor for audio processing
            const sourceNode = audioContext.createMediaStreamSource(mediaStream);
            audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
            
            // Connect nodes
            sourceNode.connect(audioProcessor);
            audioProcessor.connect(audioContext.destination);
            
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
            statusElement.textContent = 'Listening';
            statusElement.className = 'listening';
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
        
        // Stop recording
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        
        // Release resources
        if (audioProcessor) {
            audioProcessor.disconnect();
            audioProcessor = null;
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
        statusElement.textContent = 'Connected';
        statusElement.className = 'connected';
        startBtn.disabled = false;
        stopBtn.disabled = true;
    }
    
    // Event listeners
    startBtn.addEventListener('click', startRecording);
    stopBtn.addEventListener('click', stopRecording);
    
    // Connect to server when page loads
    connectWebSocket();
});