import { startTransition, useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'
import {
  createActivityRequestId,
  loadClientConfig,
  resetAiRuntimeSettings,
  revealLocalFile,
  saveAiRuntimeSettings,
  searchJob,
  selectLocalFolder,
  startProcessing,
  subscribeToActivityLog,
} from './api'
import type {
  ActivityLogEntry,
  AiProviderKind,
  ClientConfigResponse,
  ProcessResponse,
  SearchResult,
  TranscriptMatch,
} from './types'

function App() {
  const [sourceMode, setSourceMode] = useState<'local' | 'frameio'>('local')
  const [localPath, setLocalPath] = useState('')
  const [frameioLink, setFrameioLink] = useState('')
  const [frameioToken, setFrameioToken] = useState('')
  const [frameioSessionCookie, setFrameioSessionCookie] = useState('')
  const [transcriptText, setTranscriptText] = useState('')
  const [transcriptFile, setTranscriptFile] = useState<File | null>(null)
  const [rankingFile, setRankingFile] = useState<File | null>(null)
  const [searchText, setSearchText] = useState('')
  const [aiProvider, setAiProvider] = useState<AiProviderKind>('auto')
  const [aiModel, setAiModel] = useState('qwen3.5:latest')
  const [maxCandidates, setMaxCandidates] = useState(40)
  const [maxMatches, setMaxMatches] = useState(8)
  const [forceRefresh, setForceRefresh] = useState(false)
  const [processResult, setProcessResult] = useState<ProcessResponse | null>(null)
  const [results, setResults] = useState<SearchResult[]>([])
  const [config, setConfig] = useState<ClientConfigResponse | null>(null)
  const [ollamaBaseUrlInput, setOllamaBaseUrlInput] = useState('')
  const [ollamaRuntimeModelInput, setOllamaRuntimeModelInput] = useState('qwen3.5:latest')
  const [openRouterBaseUrlInput, setOpenRouterBaseUrlInput] = useState(DEFAULT_OPENROUTER_BASE_URL)
  const [openRouterRuntimeModelInput, setOpenRouterRuntimeModelInput] = useState(DEFAULT_OPENROUTER_MODEL)
  const [openRouterApiKeyInput, setOpenRouterApiKeyInput] = useState('')
  const [isSavingAiRuntime, setIsSavingAiRuntime] = useState(false)
  const [aiRuntimeMessage, setAiRuntimeMessage] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [isPickingLocalFolder, setIsPickingLocalFolder] = useState(false)
  const [revealingPath, setRevealingPath] = useState('')
  const [error, setError] = useState('')
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>([])
  const [activityRequestId, setActivityRequestId] = useState('')
  const [activityState, setActivityState] = useState<'idle' | 'connecting' | 'live' | 'closed'>('idle')

  const deferredSearchText = useDeferredValue(searchText)

  function applyRuntimeDrafts(nextConfig: ClientConfigResponse) {
    setOllamaBaseUrlInput(nextConfig.ai.runtime.ollamaBaseUrl)
    setOllamaRuntimeModelInput(nextConfig.ai.runtime.ollamaModel)
    setOpenRouterBaseUrlInput(nextConfig.ai.runtime.openRouterBaseUrl)
    setOpenRouterRuntimeModelInput(nextConfig.ai.runtime.openRouterModel)
    setOpenRouterApiKeyInput('')
  }

  useEffect(() => {
    loadClientConfig()
      .then((nextConfig) => {
        setConfig(nextConfig)
        applyRuntimeDrafts(nextConfig)
        setAiProvider(nextConfig.ai.defaultProvider ?? 'auto')
        setAiModel(resolveDefaultModel(nextConfig, nextConfig.ai.defaultProvider ?? 'auto'))
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!activityRequestId) {
      setActivityState('idle')
      return
    }

    const unsubscribe = subscribeToActivityLog(activityRequestId, {
      onEntry: (entry) => {
        startTransition(() => {
          setActivityLog((current) => {
            if (current.some((existing) => existing.id === entry.id)) {
              return current
            }

            return [...current, entry]
          })
        })
      },
      onStateChange: (nextState) => {
        setActivityState(nextState)
      },
      onError: (message) => {
        setError((current) => current || message)
      },
    })

    return unsubscribe
  }, [activityRequestId])

  useEffect(() => {
    if (!processResult) {
      return
    }

    let ignore = false
    setIsSearching(true)

    searchJob(processResult.jobId, deferredSearchText)
      .then((nextResults) => {
        if (ignore) {
          return
        }

        startTransition(() => {
          setResults(nextResults)
        })
      })
      .catch((searchError: unknown) => {
        if (!ignore) {
          setError(searchError instanceof Error ? searchError.message : 'Search failed.')
        }
      })
      .finally(() => {
        if (!ignore) {
          setIsSearching(false)
        }
      })

    return () => {
      ignore = true
    }
  }, [deferredSearchText, processResult])

  const availableModelOptions = useMemo(() => {
    if (!config) {
      return []
    }

    const resolvedProvider = resolveConfiguredProvider(config, aiProvider)
    if (!resolvedProvider) {
      return []
    }

    if (resolvedProvider === 'gemini-cli') {
      return withDefaultModel(config.ai.geminiCli.installedModels, config.ai.geminiCli.defaultModel)
    }

    if (resolvedProvider === 'nvidia') {
      return withDefaultModel(config.ai.nvidia.installedModels, config.ai.nvidia.defaultModel)
    }

    if (resolvedProvider === 'openrouter') {
      return []
    }

    return withDefaultModel(config.ai.ollama.installedModels, config.ai.ollama.defaultModel)
  }, [aiProvider, config])

  const activeMatches = processResult?.matching?.matches ?? []
  const referenceSummary = processResult?.references
  const resolvedProvider = config ? resolveConfiguredProvider(config, aiProvider) : aiProvider === 'auto' ? null : aiProvider
  const hasActiveSource = sourceMode === 'local' ? localPath.trim().length > 0 : frameioLink.trim().length > 0
  const hasTranscript = transcriptText.trim().length > 0 || Boolean(transcriptFile)
  const isPublicShareLink = isPublicFrameIoShareLink(frameioLink)
  const hasFrameIoAuth =
    Boolean(frameioToken.trim()) ||
    Boolean(frameioSessionCookie.trim()) ||
    Boolean(config?.frameio.hasEnvBearerToken) ||
    Boolean(config?.frameio.hasEnvSessionCookie) ||
    Boolean(config?.frameio.hasSessionBearerToken) ||
    Boolean(config?.frameio.hasSessionSessionCookie)

  async function refreshConfig() {
    const nextConfig = await loadClientConfig()
    setConfig(nextConfig)
    applyRuntimeDrafts(nextConfig)
    return nextConfig
  }

  function handleProviderChange(nextProvider: AiProviderKind) {
    setAiProvider(nextProvider)
    if (config) {
      setAiModel(resolveDefaultModel(config, nextProvider))
    }
  }

  async function handleSaveAiRuntime() {
    setIsSavingAiRuntime(true)
    setError('')
    setAiRuntimeMessage('')

    try {
      const nextConfig = await saveAiRuntimeSettings({
        ollamaBaseUrl: ollamaBaseUrlInput,
        ollamaModel: ollamaRuntimeModelInput,
        openRouterBaseUrl: openRouterBaseUrlInput,
        openRouterModel: openRouterRuntimeModelInput,
        openRouterApiKey: openRouterApiKeyInput,
      })
      setConfig(nextConfig)
      applyRuntimeDrafts(nextConfig)
      const activeProvider = resolveConfiguredProvider(nextConfig, aiProvider)
      if (activeProvider === 'ollama') {
        setAiModel(nextConfig.ai.ollama.defaultModel)
      } else if (activeProvider === 'openrouter') {
        setAiModel(nextConfig.ai.openRouter.defaultModel)
      }
      setAiRuntimeMessage(buildAiRuntimeSaveMessage(nextConfig))
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save AI runtime settings.')
    } finally {
      setIsSavingAiRuntime(false)
    }
  }

  async function handleResetAiRuntime() {
    setIsSavingAiRuntime(true)
    setError('')
    setAiRuntimeMessage('')

    try {
      const nextConfig = await resetAiRuntimeSettings()
      setConfig(nextConfig)
      applyRuntimeDrafts(nextConfig)
      const activeProvider = resolveConfiguredProvider(nextConfig, aiProvider)
      if (activeProvider === 'ollama') {
        setAiModel(nextConfig.ai.ollama.defaultModel)
      }
      if (activeProvider === 'openrouter') {
        setAiModel(nextConfig.ai.openRouter.defaultModel)
      }
      setAiRuntimeMessage('Saved AI runtime overrides cleared. Environment defaults are active again.')
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : 'Unable to reset AI runtime settings.')
    } finally {
      setIsSavingAiRuntime(false)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsProcessing(true)
    setError('')
    const nextRequestId = createActivityRequestId()
    setActivityLog([])
    setActivityRequestId(nextRequestId)

    if (sourceMode === 'frameio' && !isPublicShareLink && !hasFrameIoAuth) {
      setIsProcessing(false)
      setError('Frame.io links need a bearer token or session cookie. Add Frame.io auth in the app before processing this link.')
      return
    }

    try {
      const nextResult = await startProcessing({
        requestId: nextRequestId,
        sourceMode,
        localPath,
        frameioLink,
        frameioToken,
        frameioSessionCookie,
        transcriptText,
        transcriptFile,
        rankingFile,
        aiProvider,
        aiModel,
        maxCandidates,
        maxMatches,
        forceRefresh,
      })
      setProcessResult(nextResult)
      setSearchText('')
      await refreshConfig()
    } catch (submitError) {
      setProcessResult(null)
      setResults([])
      setError(submitError instanceof Error ? submitError.message : 'Processing failed.')
    } finally {
      setIsProcessing(false)
    }
  }

  async function handleTranscriptFileChange(file: File | null) {
    setTranscriptFile(file)
    if (!file) {
      return
    }

    try {
      const text = await file.text()
      setTranscriptText(text)
    } catch {
      setError('The selected transcript file could not be read in the browser.')
    }
  }

  async function handlePickLocalFolder() {
    setIsPickingLocalFolder(true)
    setError('')

    try {
      const selectedPath = await selectLocalFolder()
      setSourceMode('local')
      setLocalPath(selectedPath)
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : 'Unable to select a local folder.')
    } finally {
      setIsPickingLocalFolder(false)
    }
  }

  async function handleRevealLocalPath(path: string) {
    setRevealingPath(path)
    setError('')
    try {
      await revealLocalFile(path)
    } catch (revealError) {
      setError(revealError instanceof Error ? revealError.message : 'Unable to reveal the local file.')
    } finally {
      setRevealingPath('')
    }
  }

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">AI Raw File Finder</p>
          <h1>Match transcripts to raw files across local archives and Frame.io shares.</h1>
          <p className="hero-copy">
            This app now does two jobs: it recursively ingests your archive source, then it uses a real model
            provider to reason over the transcript and rank likely raw files with evidence and direct links.
          </p>
        </div>
        <div className="hero-metrics">
          <article>
            <span>AI Provider</span>
            <strong>{processResult?.matching?.provider ?? aiProvider}</strong>
          </article>
          <article>
            <span>{referenceSummary ? 'Matched References' : 'Matched Files'}</span>
            <strong>{referenceSummary?.matchedCount ?? processResult?.summary.matchedCount ?? 0}</strong>
          </article>
          <article>
            <span>Archive Items</span>
            <strong>{processResult?.summary.fileCount ?? 0}</strong>
          </article>
        </div>
      </section>

      <form className="workspace" onSubmit={handleSubmit}>
        <section className="panel source-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Source Setup</p>
              <h2>Archive input</h2>
            </div>
            <div className="segment-control" role="tablist" aria-label="Archive source mode">
              <button
                className={sourceMode === 'local' ? 'segment active' : 'segment'}
                type="button"
                onClick={() => setSourceMode('local')}
              >
                Local archive
              </button>
              <button
                className={sourceMode === 'frameio' ? 'segment active' : 'segment'}
                type="button"
                onClick={() => setSourceMode('frameio')}
              >
                Frame.io link
              </button>
            </div>
          </div>

          <div className="stack">
            <div className={sourceMode === 'local' ? 'source-card active' : 'source-card'}>
              <label className="field">
                <span>Local archive root</span>
                <div className="field-actions">
                  <input
                    type="text"
                    value={localPath}
                    onChange={(event) => setLocalPath(event.target.value)}
                    placeholder="D:\\Exports\\Frame Archive"
                  />
                  <button className="secondary-action" type="button" onClick={handlePickLocalFolder} disabled={isPickingLocalFolder}>
                    {isPickingLocalFolder ? 'Opening...' : 'Select'}
                  </button>
                </div>
                <small>Use the mirrored archive root on this machine.</small>
              </label>
            </div>

            <div className={sourceMode === 'frameio' ? 'source-card active' : 'source-card'}>
              <label className="field">
                <span>Frame.io share or folder link</span>
                <input
                  type="url"
                  value={frameioLink}
                  onChange={(event) => setFrameioLink(event.target.value)}
                  placeholder="https://app.frame.io/... or https://f.io/..."
                />
                <small>
                  Public `next.frame.io/share/...` links can run without a token. Protected links still need Frame.io auth.
                </small>
              </label>
            </div>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={forceRefresh}
                onChange={(event) => setForceRefresh(event.target.checked)}
              />
              <span>Force a fresh sync and ignore cached traversal state</span>
            </label>
          </div>
        </section>

        <section className="panel transcript-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Transcript</p>
              <h2>What the model should match</h2>
            </div>
          </div>

          <div className="stack">
            <label className="field">
              <span>Paste transcript text</span>
              <textarea
                rows={10}
                value={transcriptText}
                onChange={(event) => setTranscriptText(event.target.value)}
                placeholder="Paste the transcript, scene summary, or editor notes here..."
              />
              <small>The transcript text is sent into the AI matching stage after archive discovery.</small>
            </label>

            <div className="upload-grid">
              <label className="field">
                <span>Transcript file</span>
                <input type="file" accept=".txt,.srt,.vtt,.md,.csv" onChange={(event) => void handleTranscriptFileChange(event.target.files?.[0] ?? null)} />
                <small>Optional. The selected transcript file is loaded into the transcript box immediately.</small>
              </label>

              <label className="field">
                <span>Ranked text file</span>
                <input type="file" accept=".txt,.csv" onChange={(event) => setRankingFile(event.target.files?.[0] ?? null)} />
                <small>Optional. One term per line, or `term,weight` to bias ranking.</small>
              </label>
            </div>

            <div className="file-status-row">
              <span>{transcriptFile ? `Transcript file: ${transcriptFile.name}` : 'No transcript file selected'}</span>
              <span>{rankingFile ? `Ranking file: ${rankingFile.name}` : 'No ranking file selected'}</span>
            </div>
          </div>
        </section>

        <section className="panel model-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Model</p>
              <h2>AI computing provider</h2>
            </div>
            <span className="provider-chip">
              {config?.ai.defaultProvider ? `Default ${config.ai.defaultProvider}` : 'No provider detected'}
            </span>
          </div>

          <div className="control-columns">
            <div className="stack">
              <label className="field">
                <span>Provider</span>
                <select value={aiProvider} onChange={(event) => handleProviderChange(event.target.value as AiProviderKind)}>
                  <option value="auto">Auto</option>
                  <option value="ollama">Ollama (local or remote)</option>
                  <option value="gemini-cli">Gemini CLI</option>
                  <option value="nvidia">NVIDIA API</option>
                  <option value="openrouter">OpenRouter</option>
                </select>
                <small>Auto follows the server default provider and falls back based on runtime availability.</small>
              </label>

              <label className="field">
                <span>Model</span>
                {availableModelOptions.length > 0 ? (
                  <select value={aiModel} onChange={(event) => setAiModel(event.target.value)}>
                    {availableModelOptions.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={aiModel}
                    onChange={(event) => setAiModel(event.target.value)}
                    placeholder={
                      resolvedProvider === 'gemini-cli'
                        ? 'gemini-3.1-pro-preview'
                        : resolvedProvider === 'nvidia'
                          ? 'qwen/qwen3.5-122b-a10b'
                          : resolvedProvider === 'openrouter'
                            ? DEFAULT_OPENROUTER_MODEL
                            : 'qwen3.5:latest'
                    }
                  />
                )}
              </label>
            </div>

            <div className="stack">
              <label className="field">
                <span>Candidate pool</span>
                <input
                  type="number"
                  min={10}
                  max={100}
                  value={maxCandidates}
                  onChange={(event) => setMaxCandidates(Number(event.target.value))}
                />
                <small>How many archive candidates to pre-rank before the model reasons over them.</small>
              </label>

              <label className="field">
                <span>Max returned matches</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={maxMatches}
                  onChange={(event) => setMaxMatches(Number(event.target.value))}
                />
                <small>How many likely raw files to return in the AI result list.</small>
              </label>
            </div>
          </div>

          <div className="runtime-config-card">
            <div className="panel-header">
              <div>
                <p className="eyebrow">AI Runtime</p>
                <h2>Saved provider defaults and compatible endpoints</h2>
              </div>
              <span className={`runtime-pill ${config?.ai.runtime.usesRemoteOllama ? 'remote' : 'local'}`}>
                {config?.ai.runtime.usesRemoteOllama ? 'Remote' : 'Local'}
              </span>
            </div>

            <div className="control-columns">
              <div className="stack">
                <label className="field">
                  <span>Ollama endpoint URL</span>
                  <input
                    type="url"
                    value={ollamaBaseUrlInput}
                    onChange={(event) => setOllamaBaseUrlInput(event.target.value)}
                    placeholder="https://example.trycloudflare.com"
                  />
                  <small>Use this for a Colab tunnel or another remote GPU host. Leave it blank to fall back to the local `.env` value.</small>
                </label>

                <label className="field">
                  <span>Saved Ollama model</span>
                  <input
                    type="text"
                    value={ollamaRuntimeModelInput}
                    onChange={(event) => setOllamaRuntimeModelInput(event.target.value)}
                    placeholder="qwen3.5:latest"
                  />
                  <small>This becomes the default Ollama model after runtime settings are saved.</small>
                </label>
              </div>

              <div className="stack">
                <label className="field">
                  <span>OpenRouter base URL</span>
                  <input
                    type="url"
                    value={openRouterBaseUrlInput}
                    onChange={(event) => setOpenRouterBaseUrlInput(event.target.value)}
                    placeholder={DEFAULT_OPENROUTER_BASE_URL}
                  />
                  <small>Keep the OpenRouter API default, or point at another OpenAI-compatible gateway if the backend supports it.</small>
                </label>

                <label className="field">
                  <span>Saved OpenRouter model</span>
                  <input
                    type="text"
                    value={openRouterRuntimeModelInput}
                    onChange={(event) => setOpenRouterRuntimeModelInput(event.target.value)}
                    placeholder={DEFAULT_OPENROUTER_MODEL}
                  />
                  <small>This becomes the default model when OpenRouter is the active provider.</small>
                </label>

                <label className="field">
                  <span>OpenRouter API key</span>
                  <input
                    type="password"
                    value={openRouterApiKeyInput}
                    onChange={(event) => setOpenRouterApiKeyInput(event.target.value)}
                    placeholder="sk-or-v1-..."
                  />
                  <small>Saved only on this machine. Leave blank to keep the existing saved key or use the env var.</small>
                </label>
              </div>
            </div>

            <div className="runtime-summary-row">
              <span className="runtime-summary-label">Active Ollama endpoint</span>
              <code>{config?.ai.runtime.ollamaBaseUrl ?? 'Loading...'}</code>
            </div>

            <div className="runtime-summary-row">
              <span className="runtime-summary-label">OpenRouter base URL</span>
              <code>{config?.ai.runtime.openRouterBaseUrl ?? 'Loading...'}</code>
            </div>

            <div className="runtime-summary-row">
              <span className="runtime-summary-label">OpenRouter default model</span>
              <code>{config?.ai.runtime.openRouterModel ?? 'Loading...'}</code>
            </div>

            <div className="runtime-summary-row">
              <span className="runtime-summary-label">OpenRouter auth</span>
              <code>{config?.ai.runtime.hasOpenRouterApiKey ? 'Configured' : 'Missing'}</code>
            </div>

            <div className="runtime-actions">
              <button className="secondary-action" type="button" onClick={() => void handleSaveAiRuntime()} disabled={isSavingAiRuntime}>
                {isSavingAiRuntime ? 'Saving...' : 'Save Runtime Settings'}
              </button>
              <button className="secondary-action" type="button" onClick={() => void handleResetAiRuntime()} disabled={isSavingAiRuntime}>
                Reset to Env Defaults
              </button>
            </div>

            {aiRuntimeMessage ? <p className="inline-success">{aiRuntimeMessage}</p> : null}
          </div>

          <div className="status-inline-grid">
            <article className="inline-status">
              <span>Ollama</span>
              <strong>{config?.ai.ollama.available ? 'Ready' : 'Offline'}</strong>
            </article>
            <article className="inline-status">
              <span>Ollama endpoint</span>
              <strong>{config?.ai.runtime.usesRemoteOllama ? 'Remote' : 'Local'}</strong>
            </article>
            <article className="inline-status">
              <span>Gemini CLI</span>
              <strong>{config?.ai.geminiCli.available ? 'Ready' : 'Missing'}</strong>
            </article>
            <article className="inline-status">
              <span>NVIDIA API</span>
              <strong>{config?.ai.nvidia.available ? 'Ready' : 'Missing'}</strong>
            </article>
            <article className="inline-status">
              <span>OpenRouter</span>
              <strong>{config?.ai.openRouter.available ? 'Ready' : 'Missing'}</strong>
            </article>
            <article className="inline-status">
              <span>Frame.io auth</span>
              <strong>
                {config?.frameio.hasEnvBearerToken ||
                config?.frameio.hasEnvSessionCookie ||
                config?.frameio.hasSessionBearerToken ||
                config?.frameio.hasSessionSessionCookie
                  ? 'Configured'
                  : 'Unset'}
              </strong>
            </article>
          </div>

          <div className="auth-grid">
            <label className="field">
              <span>Frame.io bearer token</span>
              <input
                type="password"
                placeholder="Optional. Stored in the local app session."
                value={frameioToken}
                onChange={(event) => setFrameioToken(event.target.value)}
              />
            </label>

            <label className="field">
              <span>Frame.io session cookie</span>
              <input
                type="password"
                placeholder="Optional alternative for authenticated links."
                value={frameioSessionCookie}
                onChange={(event) => setFrameioSessionCookie(event.target.value)}
              />
            </label>
          </div>

          <div className="submit-row">
            <div className="submit-copy">
              <strong>{hasTranscript ? 'Transcript ready for AI matching.' : 'Add transcript text or a transcript file.'}</strong>
              <p>The app will ingest the archive source first, then run AI reasoning over the transcript and candidate raw files.</p>
            </div>
            <button className="primary-action" disabled={!hasActiveSource || isProcessing || !aiModel.trim()} type="submit">
              {isProcessing ? 'Processing archive and AI matching...' : 'Start Processing'}
            </button>
          </div>
          {sourceMode === 'frameio' && isPublicShareLink ? (
            <p className="inline-success">
              Public Frame.io share detected. The app will use the no-token browser automation path for archive discovery.
            </p>
          ) : null}
          {sourceMode === 'frameio' && !isPublicShareLink && !hasFrameIoAuth ? (
            <p className="inline-warning">
              Frame.io auth is currently missing. Your configured AI provider can still handle transcript matching, but Frame.io traversal still needs Frame.io credentials.
            </p>
          ) : null}
          {error ? <p className="error-banner">{error}</p> : null}
        </section>
      </form>

      <section className="status-grid">
        <article className="status-card accent">
          <span className="status-label">Current source</span>
          <strong>{processResult?.source.kind ?? sourceMode}</strong>
          <p>{processResult?.source.input ?? 'Select a local archive or paste a Frame.io link.'}</p>
        </article>
        <article className="status-card">
          <span className="status-label">AI run</span>
          <strong>{processResult?.matching?.status ?? 'idle'}</strong>
          <p>
            {processResult?.matching
              ? `${processResult.matching.provider} / ${processResult.matching.model}`
              : 'Provider selection will be applied on the next run.'}
          </p>
        </article>
        <article className="status-card">
          <span className="status-label">Traversal cache</span>
          <strong>{processResult?.summary.resumed ? 'Resumed' : 'Fresh'}</strong>
          <p>{processResult?.summary.cachePath ?? 'No cached traversal state has been created yet.'}</p>
        </article>
        <article className="status-card">
          <span className="status-label">Transcript</span>
          <strong>{processResult?.transcript.hasTranscript ? 'Loaded' : 'Missing'}</strong>
          <p>
            {processResult?.transcript.hasTranscript
              ? `${processResult.transcript.textLength} characters`
              : 'Transcript input is needed for semantic matching.'}
          </p>
        </article>
        <article className="status-card">
          <span className="status-label">Reference Clips</span>
          <strong>{referenceSummary ? `${referenceSummary.matchedCount}/${referenceSummary.totalCount}` : 'Pending'}</strong>
          <p>
            {referenceSummary
              ? `${referenceSummary.unresolvedCount} unresolved, ${referenceSummary.failedCount} failed`
              : 'Reference processing summary will appear after the backend emits it.'}
          </p>
        </article>
      </section>

      <section className="panel activity-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Activity Log</p>
            <h2>Live run activity</h2>
          </div>
          <div className="activity-meta">
            <span>{activityLog.length} entries</span>
            <span className={`activity-state-chip ${activityState}`}>
              {activityState === 'idle' ? 'Idle' : activityState}
            </span>
          </div>
        </div>

        <div className="activity-log-list">
          {activityLog.length ? (
            activityLog.map((entry) => (
              <article className="activity-log-entry" key={entry.id}>
                <div className="activity-log-topline">
                  <span className={`activity-level ${entry.level}`}>{entry.level}</span>
                  <strong>{entry.stage}</strong>
                  <time dateTime={entry.timestamp}>{formatActivityTime(entry.timestamp)}</time>
                </div>
                <p>{entry.message}</p>
                {entry.detail ? <small>{formatActivityDetail(entry.detail)}</small> : null}
              </article>
            ))
          ) : (
            <p className="empty-state">Start processing to watch archive discovery, AI matching, and indexing events here.</p>
          )}
        </div>
      </section>

      <section className="panel matches-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Matched Raw Files</p>
            <h2>{referenceSummary ? 'Reference-linked outputs' : 'AI-ranked outputs'}</h2>
          </div>
          <div className="matches-meta">
            <span>{activeMatches.length} matches</span>
            {processResult?.matching ? <span>{Math.round(processResult.matching.durationMs / 1000)}s AI time</span> : null}
          </div>
        </div>

        {referenceSummary ? (
          <div className="reference-summary-row">
            <span className="reference-summary-pill">references {referenceSummary.totalCount}</span>
            <span className="reference-summary-pill success">matched {referenceSummary.matchedCount}</span>
            <span className="reference-summary-pill warning">unresolved {referenceSummary.unresolvedCount}</span>
            <span className="reference-summary-pill error">failed {referenceSummary.failedCount}</span>
          </div>
        ) : null}

        {processResult?.matching?.notes.length ? (
          <div className="warning-box">
            {processResult.matching.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        ) : null}

        <div className="matches-list">
          {activeMatches.map((match, index) => (
            <MatchCard
              key={`${match.recordId}-${match.referenceUrl ?? match.referenceTitle ?? index}`}
              match={match}
              onRevealLocalPath={handleRevealLocalPath}
              revealingPath={revealingPath}
            />
          ))}
          {!activeMatches.length ? (
            <p className="empty-state">Run processing with a transcript to get AI-ranked raw file matches here.</p>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <div className="search-header">
          <div>
            <p className="eyebrow">Archive Search</p>
            <h2>Fallback search across the indexed archive</h2>
          </div>
          <input
            className="search-input"
            type="search"
            placeholder="Search filenames, paths, and indexed metadata"
            value={searchText}
            disabled={!processResult}
            onChange={(event) => setSearchText(event.target.value)}
          />
        </div>

        {processResult?.rankingTerms.length ? (
          <div className="tag-row">
            {processResult.rankingTerms.map((term) => (
              <span className="term-tag" key={`${term.term}-${term.weight}`}>
                {term.term} x {term.weight}
              </span>
            ))}
          </div>
        ) : null}

        <div className="results-meta">
          <span>{isSearching ? 'Refreshing results...' : `${results.length} results`}</span>
          {processResult?.summary.cachePath ? <span>{processResult.summary.cachePath}</span> : null}
        </div>

        <div className="results-list">
          {results.map((result) => (
            <article className="result-card" key={result.record.id}>
              <div className="result-topline">
                <strong>{result.record.name}</strong>
                <span>{result.record.sourceKind}</span>
              </div>
              <p className="result-path">{result.record.relativePath}</p>
              <div className="result-meta">
                <span>{result.record.mediaType}</span>
                <span>{result.record.extension || 'n/a'}</span>
                <span>{result.record.size ? `${Math.round(result.record.size / 1024 / 1024)} MB` : 'size unknown'}</span>
                <span>score {result.score.toFixed(2)}</span>
              </div>
            </article>
          ))}
          {!results.length && processResult ? <p className="empty-state">No indexed files match the current search.</p> : null}
        </div>
      </section>
    </main>
  )
}

function MatchCard(input: {
  match: TranscriptMatch
  revealingPath: string
  onRevealLocalPath: (path: string) => Promise<void>
}) {
  const { match, revealingPath, onRevealLocalPath } = input
  const isLocal = match.record.sourceKind === 'local'
  const referenceStatus = match.referenceMatchStatus ?? (match.referenceUrl ? 'matched' : undefined)

  return (
    <article className="match-card">
      <div className="match-header">
        <div>
          <p className="match-rank">{Math.round(match.confidence * 100)}%</p>
          <h3>{match.record.name}</h3>
        </div>
        <div className="match-kind-stack">
          <span className="match-kind">{match.record.sourceKind}</span>
          {referenceStatus ? <span className={`reference-kind ${referenceStatus}`}>{referenceStatus}</span> : null}
        </div>
      </div>

      <p className="match-path">{match.record.relativePath}</p>
      <p className="match-reason">{match.rationale}</p>

      {match.referenceTitle ? (
        <div className="reference-detail-box">
          <strong>Reference clip</strong>
          <p>{match.referenceTitle}</p>
        </div>
      ) : null}

      {match.transcriptEvidence ? <blockquote className="evidence-box">{match.transcriptEvidence}</blockquote> : null}

      {match.referenceTranscriptPreview ? (
        <blockquote className="reference-evidence-box">{match.referenceTranscriptPreview}</blockquote>
      ) : null}

      {match.referenceReason ? <p className="reference-note">{match.referenceReason}</p> : null}

      {match.matchedTerms.length ? (
        <div className="tag-row compact">
          {match.matchedTerms.map((term) => (
            <span className="term-tag" key={`${match.recordId}-${term}`}>
              {term}
            </span>
          ))}
        </div>
      ) : null}

      <div className="match-link-stack">
        {match.referenceUrl ? (
          <a className="meta-link" href={match.referenceUrl} target="_blank" rel="noreferrer">
            Open reference link
          </a>
        ) : referenceStatus === 'unresolved' ? (
          <span className="meta-note">Reference clip unresolved for this raw match.</span>
        ) : referenceStatus === 'failed' ? (
          <span className="meta-note">Reference clip processing failed for this item.</span>
        ) : null}
        {match.sourceLink ? (
          <a className="meta-link" href={match.sourceLink} target="_blank" rel="noreferrer">
            Open source link
          </a>
        ) : null}
        {match.directLink ? (
          <a className="meta-link" href={match.directLink} target="_blank" rel="noreferrer">
            Open raw file
          </a>
        ) : null}
      </div>

      <div className="match-actions">
        {isLocal ? (
          <button
            className="secondary-action"
            type="button"
            disabled={revealingPath === match.record.sourcePath}
            onClick={() => onRevealLocalPath(match.record.sourcePath)}
          >
            {revealingPath === match.record.sourcePath ? 'Opening...' : 'Reveal local file'}
          </button>
        ) : null}
      </div>
    </article>
  )
}

function withDefaultModel(installedModels: string[], defaultModel: string): string[] {
  if (!defaultModel.trim()) {
    return installedModels
  }

  return installedModels.includes(defaultModel)
    ? installedModels
    : [defaultModel, ...installedModels]
}

const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const DEFAULT_OPENROUTER_MODEL = 'z-ai/glm-4.5-air:free'

function resolveConfiguredProvider(
  config: ClientConfigResponse,
  provider: AiProviderKind,
): Exclude<AiProviderKind, 'auto'> | null {
  return provider === 'auto' ? config.ai.defaultProvider : provider
}

function resolveDefaultModel(config: ClientConfigResponse, provider: AiProviderKind): string {
  if (provider === 'gemini-cli') {
    return config.ai.geminiCli.defaultModel
  }

  if (provider === 'nvidia') {
    return config.ai.nvidia.defaultModel
  }

  if (provider === 'ollama') {
    return config.ai.ollama.defaultModel
  }

  if (provider === 'openrouter') {
    return config.ai.openRouter.defaultModel
  }

  if (config.ai.defaultProvider === 'gemini-cli') {
    return config.ai.geminiCli.defaultModel
  }

  if (config.ai.defaultProvider === 'nvidia') {
    return config.ai.nvidia.defaultModel
  }

  if (config.ai.defaultProvider === 'openrouter') {
    return config.ai.openRouter.defaultModel
  }

  return config.ai.ollama.defaultModel
}

function buildAiRuntimeSaveMessage(config: ClientConfigResponse): string {
  const parts = ['AI runtime settings saved.']

  parts.push(
    config.ai.runtime.usesRemoteOllama
      ? 'Ollama is using the remote endpoint.'
      : 'Ollama is using the local endpoint.',
  )

  if (config.ai.runtime.hasOpenRouterApiKey) {
    parts.push('OpenRouter defaults are available for provider selection.')
  }

  return parts.join(' ')
}

function isPublicFrameIoShareLink(value: string): boolean {
  try {
    const url = new URL(value)
    return url.hostname.toLowerCase() === 'f.io' || (url.hostname.endsWith('frame.io') && /\/share\//i.test(url.pathname))
  } catch {
    return false
  }
}

function formatActivityTime(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return value
  }

  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatActivityDetail(detail: Record<string, unknown>): string {
  return Object.entries(detail)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join(' | ')
}

export default App
