// AGPL-3.0: browser adapter for the bundled Butterscotch/miniaudio bridge.
export function createBufferedAudioProcessor(context, frames, inputs, outputs, requestedFrames) {
  if (!Number.isInteger(frames) || frames < 256 || !Number.isFinite(requestedFrames) || requestedFrames <= frames) {
    return context.createScriptProcessor(frames, inputs, outputs);
  }
  const size = Math.max(frames, Math.min(16384, 2 ** Math.ceil(Math.log2(requestedFrames))));
  const node = context.createScriptProcessor(size, inputs, outputs);
  let callback = null;
  // Keep the native mixer's original block size and allocated WASM buffer.
  Object.defineProperty(node, 'onaudioprocess', {
    configurable: true,
    get: () => callback,
    set: value => { callback = typeof value === 'function' ? value : null; }
  });
  function sliceBuffer(buffer, offset) {
    if (!buffer) return null;
    return {
      length: frames,
      duration: frames / buffer.sampleRate,
      sampleRate: buffer.sampleRate,
      numberOfChannels: buffer.numberOfChannels,
      getChannelData: channel => buffer.getChannelData(channel).subarray(offset, offset + frames)
    };
  }
  node.addEventListener('audioprocess', event => {
    if (!callback) return;
    for (let offset = 0; offset < event.outputBuffer.length; offset += frames) {
      callback.call(node, {
        inputBuffer: sliceBuffer(event.inputBuffer, offset),
        outputBuffer: sliceBuffer(event.outputBuffer, offset),
        playbackTime: event.playbackTime + offset / context.sampleRate
      });
    }
  });
  return node;
}
