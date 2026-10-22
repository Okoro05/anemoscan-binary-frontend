// Everything the web app says to the server lives here, so the server address is
// configured in one place (VITE_API_URL) and the contract is easy to test.

export const API_BASE: string = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '')

export type Gender = 'male' | 'female'

export type Capture = {
  id: number
  patientId: string
  scanNumber: number
  name: string
  status: string
  cameraLabel: string
  threshold: number
  brightness: number
  sharpness: number
  contrast: number
  overall: number
  age: number | null
  gender: string | null
  imageUrl: string
  anemiaDetected: boolean | null
  anemiaProbability: number | null
  anemiaStatus: string | null
  analyzedAt: string | null
  createdAt: string
}

export type NewCapture = {
  imageData: string
  patientId: string
  age: number
  gender: Gender
  metrics: { brightness: number; sharpness: number; contrast: number; overall: number }
  threshold: number
  cameraLabel: string
  status: string
}

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function detailToMessage(detail: unknown): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((item) => (item && typeof item === 'object' && 'msg' in item ? String(item.msg) : String(item)))
      .map((message) => message.replace(/^Value error, /, ''))
      .join(' ')
  }
  return 'Something went wrong.'
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      credentials: 'include',
      ...init,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError(0, 'Cannot reach the server. Check your connection.')
  }

  if (!response.ok) {
    let message = `Request failed (${response.status}).`
    try {
      const body = await response.json()
      message = detailToMessage(body?.detail)
    } catch {
      // keep generic message
    }
    throw new ApiError(response.status, message)
  }

  return (await response.json()) as T
}

export function createCapture(body: NewCapture) {
  return request<Capture>('/api/captures', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function analyzeCapture(id: number, signal?: AbortSignal) {
  return request<Capture>(`/api/captures/${id}/analyze`, { method: 'POST', signal })
}

export const imageUrl = (capture: Capture) => `${API_BASE}${capture.imageUrl}`
