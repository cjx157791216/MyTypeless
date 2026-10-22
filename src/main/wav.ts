/**
 * PCM(16bit, mono, 16kHz) → WAV 容器。M1 目标采样率固定 16k（渲染端重采样后上传）。
 */

/** 44 字节的 WAV 文件头：dataSize 为其后 PCM 数据的字节数（会议录音按块流式写入时先写头，D-044） */
export function wavHeader(dataSize: number, sampleRate = 16000, channels = 1): Buffer {
  const bytesPerSample = 2
  const blockAlign = channels * bytesPerSample
  const buffer = Buffer.alloc(44)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16) // PCM chunk size
  buffer.writeUInt16LE(1, 20) // PCM format
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * blockAlign, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)
  return buffer
}

export function pcm16ToWav(pcm: Int16Array, sampleRate = 16000, channels = 1): Buffer {
  const dataSize = pcm.length * 2
  const buffer = Buffer.alloc(44 + dataSize)
  wavHeader(dataSize, sampleRate, channels).copy(buffer, 0)
  for (let i = 0; i < pcm.length; i++) {
    buffer.writeInt16LE(pcm[i], 44 + i * 2)
  }
  return buffer
}
