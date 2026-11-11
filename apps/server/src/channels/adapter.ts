export interface StreamAdapter {
  update(fullText: string): Promise<void>
  complete(finalText: string): Promise<void>
  abort(errorMessage?: string): Promise<void>
}

export interface TypingHandle {
  clear(): Promise<void>
}

export interface ImageUploadResult {
  /** Markdown-embeddable reference (e.g. Feishu img_key) */
  markdownRef: string
}

export interface ChannelAdapter {
  /** Send a text reply (new message or reply to messageId) */
  reply(chatId: string, text: string, replyToMessageId?: string | number): Promise<void>
  /** Show typing / processing indicator */
  showTyping(chatId: string, messageId?: string | number): Promise<TypingHandle | null>
  /** Create a streaming session (null if not supported) */
  createStreaming?(
    chatId: string,
    replyToMessageId?: string | number,
  ): Promise<StreamAdapter | null>
  /** Mark message as processed successfully */
  markDone?(chatId: string, messageId?: string | number): Promise<void>
  /** Mark message as failed */
  markError?(chatId: string, messageId?: string | number): Promise<void>
  /** Upload an image and return a reference for markdown embedding */
  uploadImage?(imageBuffer: Buffer): Promise<ImageUploadResult | null>
  /** Send a standalone image */
  sendImage?(chatId: string, imageBuffer: Buffer): Promise<void>
}
