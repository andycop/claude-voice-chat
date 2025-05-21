class AudioSampleProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    
    // Setup message port for communicating with the main thread
    this.port.onmessage = this.handleMessage.bind(this);
    
    // Get the default sample rate of the audio context
    this.originalSampleRate = sampleRate;
    
    // Target sample rate for Speechmatics (16kHz)
    this.targetSampleRate = 16000;
    
    // Resampling ratio
    this.ratio = this.targetSampleRate / this.originalSampleRate;
    
    console.log(`Resampling audio from ${this.originalSampleRate}Hz to ${this.targetSampleRate}Hz (ratio: ${this.ratio})`);
    
    // Buffer for resampling
    this.resampleBuffer = [];
    this.resampleCounter = 0;
  }
  
  handleMessage(event) {
    // Handle messages from the main thread if needed
    console.log('Message received from main thread:', event.data);
  }
  
  // Linear interpolation for resampling
  resample(samples) {
    // If sample rates match, no resampling needed
    if (this.originalSampleRate === this.targetSampleRate) {
      return samples;
    }
    
    // Calculate how many output samples we'll generate
    const outputLength = Math.floor(samples.length * this.ratio);
    const output = new Float32Array(outputLength);
    
    // Downsampling from higher rate to lower rate
    if (this.ratio < 1) {
      // Simple averaging for downsampling
      for (let i = 0; i < outputLength; i++) {
        const srcIndex = Math.floor(i / this.ratio);
        output[i] = samples[srcIndex];
      }
    } 
    // Upsampling from lower rate to higher rate
    else {
      // Linear interpolation for upsampling
      for (let i = 0; i < outputLength; i++) {
        const srcIndex = i / this.ratio;
        const srcIndexFloor = Math.floor(srcIndex);
        const srcIndexCeil = Math.min(samples.length - 1, srcIndexFloor + 1);
        const t = srcIndex - srcIndexFloor; // Interpolation factor
        
        // Linear interpolation between two nearest samples
        output[i] = (1 - t) * samples[srcIndexFloor] + t * samples[srcIndexCeil];
      }
    }
    
    return output;
  }
  
  process(inputs, outputs, parameters) {
    // Get input data from the first input's first channel
    const input = inputs[0];
    
    // Only process if we have input data
    if (input && input.length > 0) {
      const samples = input[0];
      
      // Resample to 16kHz
      const resampledData = this.resample(samples);
      
      // Convert the resampled float32 data to int16 format for speech recognition
      const int16Array = new Int16Array(resampledData.length);
      for (let i = 0; i < resampledData.length; i++) {
        int16Array[i] = Math.max(-32768, Math.min(32767, resampledData[i] * 32768));
      }
      
      // Send the processed audio data to the main thread
      this.port.postMessage({
        audio: int16Array,
        sampleRate: this.targetSampleRate
      });
    }
    
    // Return true to keep the processor alive
    return true;
  }
}

// Register the processor
registerProcessor('audio-sample-processor', AudioSampleProcessor);