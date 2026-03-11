import type { ActivityLogEntry, AiProviderKind, ClientConfigResponse, ProcessResponse, SearchResult } from './types'

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = (await response.json().catch(() => ({ message: 'Request failed.' }))) as { message?: string }
    throw new Error(error.message ?? 'Request failed.')
  }

  return response.json() as Promise<T>
}

export async function loadClientConfig(): Promise<ClientConfigResponse> {
  const response = await fetch('/api/config', {
    credentials: 'include',
  })

  return readJson<ClientConfigResponse>(response)
}

export async function saveAiRuntimeSettings(input: {
  ollamaBaseUrl: string
  ollamaModel: string
  openRouterBaseUrl: string
  openRouterModel: string
  openRouterApiKey: string
}): Promise<ClientConfigResponse> {
  const response = await fetch('/api/ai/runtime', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  })

  const payload = await readJson<{ ok: true; config: ClientConfigResponse }>(response)
  return payload.config
}

export async function resetAiRuntimeSettings(): Promise<ClientConfigResponse> {
  const response = await fetch('/api/ai/runtime', {
    method: 'DELETE',
    credentials: 'include',
  })

  const payload = await readJson<{ ok: true; config: ClientConfigResponse }>(response)
  return payload.config
}

export async function saveFrameIoSession(input: {
  bearerToken: string
  sessionCookie: string
}): Promise<void> {
  const response = await fetch('/api/frameio/session', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  })

  await readJson<{ ok: true }>(response)
}

export async function selectLocalFolder(): Promise<string> {
  const response = await fetch('/api/local-folder/select', {
    method: 'POST',
    credentials: 'include',
  })
  const payload = await readJson<{ path: string }>(response)
  return payload.path
}

export async function revealLocalFile(path: string): Promise<void> {
  const response = await fetch('/api/local-file/reveal', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path }),
  })

  await readJson<{ ok: true }>(response)
}

export async function startProcessing(input: {
  requestId: string
  sourceMode: 'local' | 'frameio'
  localPath: string
  frameioLink: string
  frameioToken: string
  frameioSessionCookie: string
  transcriptText: string
  transcriptFile: File | null
  rankingFile: File | null
  aiProvider: AiProviderKind
  aiModel: string
  maxCandidates: number
  maxMatches: number
  forceRefresh: boolean
}): Promise<ProcessResponse> {
  await saveFrameIoSession({
    bearerToken: input.frameioToken.trim(),
    sessionCookie: input.frameioSessionCookie.trim(),
  })

  const formData = new FormData()
  if (input.sourceMode === 'local' && input.localPath.trim()) {
    formData.set('localPath', input.localPath.trim())
  }
  if (input.sourceMode === 'frameio' && input.frameioLink.trim()) {
    formData.set('frameioLink', input.frameioLink.trim())
  }
  if (input.transcriptText.trim()) {
    formData.set('transcriptText', input.transcriptText.trim())
  }
  formData.set('requestId', input.requestId)
  formData.set('aiProvider', input.aiProvider)
  formData.set('aiModel', input.aiModel.trim())
  formData.set('maxCandidates', String(input.maxCandidates))
  formData.set('maxMatches', String(input.maxMatches))
  formData.set('forceRefresh', String(input.forceRefresh))

  if (input.transcriptFile) {
    formData.set('transcriptFile', input.transcriptFile)
  }
  if (input.rankingFile) {
    formData.set('rankingFile', input.rankingFile)
  }

  const response = await fetch('/api/process', {
    method: 'POST',
    body: formData,
    credentials: 'include',
  })

  return readJson<ProcessResponse>(response)
}

export async function searchJob(jobId: string, query: string): Promise<SearchResult[]> {
  const response = await fetch(`/api/jobs/${jobId}/search?q=${encodeURIComponent(query)}`, {
    credentials: 'include',
  })
  const payload = await readJson<{ results: SearchResult[] }>(response)
  return payload.results
}

export function createActivityRequestId(): string {
  const randomPart =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`

  return `activity-${randomPart}`
}

export function subscribeToActivityLog(
  requestId: string,
  handlers: {
    onEntry: (entry: ActivityLogEntry) => void
    onStateChange?: (state: 'connecting' | 'live' | 'closed') => void
    onError?: (message: string) => void
  },
): () => void {
  const source = new EventSource(`/api/activity-stream?requestId=${encodeURIComponent(requestId)}`, {
    withCredentials: true,
  })

  handlers.onStateChange?.('connecting')

  source.onopen = () => {
    handlers.onStateChange?.('live')
  }

  source.addEventListener('activity', (event) => {
    const messageEvent = event as MessageEvent<string>
    if (!messageEvent.data) {
      return
    }

    try {
      const payload = JSON.parse(messageEvent.data) as ActivityLogEntry | ActivityLogEntry[]
      if (Array.isArray(payload)) {
        payload.forEach((entry) => handlers.onEntry(entry))
        return
      }

      handlers.onEntry(payload)
    } catch (error) {
      handlers.onError?.(error instanceof Error ? error.message : 'Activity log parse failed.')
    }
  })

  source.onmessage = (event) => {
    if (!event.data) {
      return
    }

    try {
      const payload = JSON.parse(event.data) as ActivityLogEntry | ActivityLogEntry[]
      if (Array.isArray(payload)) {
        payload.forEach((entry) => handlers.onEntry(entry))
        return
      }

      handlers.onEntry(payload)
    } catch (error) {
      handlers.onError?.(error instanceof Error ? error.message : 'Activity log parse failed.')
    }
  }

  source.onerror = () => {
    handlers.onStateChange?.('closed')
  }

  return () => {
    source.close()
    handlers.onStateChange?.('closed')
  }
}
