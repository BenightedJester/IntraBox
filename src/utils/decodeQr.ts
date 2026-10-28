import jsQR from 'jsqr'

/** 可解码的输入：DataURL 字符串 或 图片 Blob/File */
export type QrSource = string | Blob

/**
 * 将输入加载为 HTMLImageElement
 */
function loadImage(source: QrSource): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    let objectUrl: string | null = null

    img.onload = () => {
      // 交由调用方使用后再释放
      if (objectUrl) {
        // 延迟释放，避免解码前图片被回收
        setTimeout(() => objectUrl && URL.revokeObjectURL(objectUrl!), 1000)
      }
      resolve(img)
    }
    img.onerror = () => reject(new Error('图片加载失败'))

    if (typeof source === 'string') {
      img.src = source
    } else {
      objectUrl = URL.createObjectURL(source)
      img.src = objectUrl
    }
  })
}

/**
 * 从图片或 DataURL 中解码二维码文本
 * @returns 解码得到的字符串，未识别到时返回 null
 */
export async function decodeQr(source: QrSource): Promise<string | null> {
  const img = await loadImage(source)
  const width = img.naturalWidth || img.width
  const height = img.naturalHeight || img.height
  if (!width || !height) return null

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null

  ctx.drawImage(img, 0, 0, width, height)
  const imageData = ctx.getImageData(0, 0, width, height)

  const code = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'attemptBoth',
  })
  return code?.data ?? null
}
