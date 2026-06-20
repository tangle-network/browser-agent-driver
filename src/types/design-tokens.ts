// ============================================================================
// Design Token Extraction Types
// ============================================================================

export interface DesignTokens {
  url: string
  extractedAt: string
  viewportsAudited: string[]
  customProperties: Record<string, string>
  colors: ColorToken[]
  typography: {
    families: FontFamily[]
    scale: TypeScaleEntry[]
  }
  brand: {
    title?: string
    description?: string
    themeColor?: string
    favicon?: string
    ogImage?: string
    appleTouchIcon?: string
    manifestUrl?: string
  }
  logos: LogoAsset[]
  icons: SvgIcon[]
  fontFiles: FontFile[]
  images: ImageAsset[]
  videos: VideoAsset[]
  stylesheets: Array<{ url: string; localPath?: string }>
  responsive: Record<string, ViewportTokens>
  detectedLibraries: string[]
}

export interface VideoAsset {
  url: string
  type: 'video' | 'video-source'
  poster?: string
  localPath?: string
  mimeType?: string
  sizeBytes?: number
}

export interface ColorToken {
  value: string
  hex: string
  count: number
  properties: string[]
  cluster?: 'primary' | 'secondary' | 'accent' | 'neutral' | 'background' | 'border'
}

export interface FontFamily {
  family: string
  weights: number[]
  classification: 'heading' | 'body' | 'mono' | 'display'
}

export interface TypeScaleEntry {
  fontSize: string
  fontWeight: string
  lineHeight: string
  letterSpacing: string
  fontFamily: string
  usage: 'heading' | 'body' | 'caption' | 'label'
  tag?: string
  count: number
}

export interface LogoAsset {
  type: 'svg' | 'img'
  src?: string
  alt?: string
  width?: number
  height?: number
  svgContent?: string
}

export interface SvgIcon {
  selector: string
  viewBox?: string
  width?: number
  height?: number
  content: string
}

export interface ViewportTokens {
  width: number
  height: number
  spacing: SpacingToken[]
  gridBaseUnit?: number
  borders: BorderToken[]
  shadows: ShadowToken[]
  components: {
    buttons: ComponentFingerprint[]
    inputs: ComponentFingerprint[]
    cards: ComponentFingerprint[]
    nav: NavPattern[]
  }
  animations: AnimationToken[]
  screenshotPath?: string
}

export interface SpacingToken {
  value: string
  count: number
  properties: string[]
}

export interface BorderToken {
  borderRadius: string
  count: number
}

export interface ShadowToken {
  value: string
  count: number
}

export interface ComponentFingerprint {
  fingerprint: string
  count: number
  exampleText?: string
  styles: Record<string, string>
}

export interface NavPattern {
  selector: string
  layout: Record<string, string>
  linkCount: number
  linkStyles: Record<string, string>
}

export interface AnimationToken {
  property: string
  value: string
  count: number
}

export interface FontFile {
  family: string
  weight: string
  style: string
  src: string
  format: string
  localPath?: string
}

export interface ImageAsset {
  url: string
  type: 'img' | 'background' | 'favicon' | 'og-image' | 'icon' | 'video-poster' | 'lazy-load'
  localPath?: string
  mimeType?: string
  sizeBytes?: number
}
