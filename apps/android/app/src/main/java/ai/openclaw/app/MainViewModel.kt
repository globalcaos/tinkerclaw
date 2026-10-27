package ai.openclaw.app

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.OutgoingAttachment
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.jarvis.JarvisDoor
import ai.openclaw.app.jarvis.JarvisPairLink
import ai.openclaw.app.jarvis.JarvisScreen
import ai.openclaw.app.jarvis.defaultJarvisDoorCandidates
import ai.openclaw.app.jarvis.isAllowedJarvisDoorHost
import ai.openclaw.app.jarvis.jarvisDoorHostPort
import ai.openclaw.app.jarvis.normalizeJarvisDoorOrigin
import ai.openclaw.app.jarvis.parseJarvisPairLink
import ai.openclaw.app.jarvis.withDoorFirst
import ai.openclaw.app.node.CameraCaptureManager
import ai.openclaw.app.node.CanvasController
import ai.openclaw.app.node.SmsManager
import ai.openclaw.app.voice.VoiceConversationEntry
import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn

@OptIn(ExperimentalCoroutinesApi::class)
class MainViewModel(
  app: Application,
) : AndroidViewModel(app) {
  private val nodeApp = app as NodeApp
  private val prefs = nodeApp.prefs
  private val runtimeRef = MutableStateFlow<NodeRuntime?>(null)
  private var foreground = true
  private val _requestedHomeDestination = MutableStateFlow<HomeDestination?>(null)
  val requestedHomeDestination: StateFlow<HomeDestination?> = _requestedHomeDestination
  private val _chatDraft = MutableStateFlow<String?>(null)
  val chatDraft: StateFlow<String?> = _chatDraft
  private val _pendingAssistantAutoSend = MutableStateFlow<String?>(null)
  val pendingAssistantAutoSend: StateFlow<String?> = _pendingAssistantAutoSend

  private fun ensureRuntime(): NodeRuntime {
    runtimeRef.value?.let { return it }
    val runtime = nodeApp.ensureRuntime()
    runtime.setForeground(foreground)
    runtimeRef.value = runtime
    return runtime
  }

  private fun <T> runtimeState(
    initial: T,
    selector: (NodeRuntime) -> StateFlow<T>,
  ): StateFlow<T> =
    runtimeRef
      .flatMapLatest { runtime -> runtime?.let(selector) ?: flowOf(initial) }
      .stateIn(viewModelScope, SharingStarted.Eagerly, initial)

  val runtimeInitialized: StateFlow<Boolean> =
    runtimeRef
      .flatMapLatest { runtime -> flowOf(runtime != null) }
      .stateIn(viewModelScope, SharingStarted.Eagerly, false)

  val canvasCurrentUrl: StateFlow<String?> = runtimeState(initial = null) { it.canvas.currentUrl }
  val canvasA2uiHydrated: StateFlow<Boolean> = runtimeState(initial = false) { it.canvasA2uiHydrated }
  val canvasRehydratePending: StateFlow<Boolean> = runtimeState(initial = false) { it.canvasRehydratePending }
  val canvasRehydrateErrorText: StateFlow<String?> = runtimeState(initial = null) { it.canvasRehydrateErrorText }

  val gateways: StateFlow<List<GatewayEndpoint>> = runtimeState(initial = emptyList()) { it.gateways }
  val discoveryStatusText: StateFlow<String> = runtimeState(initial = "Searching…") { it.discoveryStatusText }
  val notificationForwardingEnabled: StateFlow<Boolean> = prefs.notificationForwardingEnabled
  val notificationForwardingMode: StateFlow<NotificationPackageFilterMode> =
    prefs.notificationForwardingMode
  val notificationForwardingPackages: StateFlow<Set<String>> = prefs.notificationForwardingPackages
  val notificationForwardingQuietHoursEnabled: StateFlow<Boolean> =
    prefs.notificationForwardingQuietHoursEnabled
  val notificationForwardingQuietStart: StateFlow<String> = prefs.notificationForwardingQuietStart
  val notificationForwardingQuietEnd: StateFlow<String> = prefs.notificationForwardingQuietEnd
  val notificationForwardingMaxEventsPerMinute: StateFlow<Int> =
    prefs.notificationForwardingMaxEventsPerMinute
  val notificationForwardingSessionKey: StateFlow<String?> = prefs.notificationForwardingSessionKey

  val isConnected: StateFlow<Boolean> = runtimeState(initial = false) { it.isConnected }
  val isNodeConnected: StateFlow<Boolean> = runtimeState(initial = false) { it.nodeConnected }
  val statusText: StateFlow<String> = runtimeState(initial = "Offline") { it.statusText }
  val serverName: StateFlow<String?> = runtimeState(initial = null) { it.serverName }
  val remoteAddress: StateFlow<String?> = runtimeState(initial = null) { it.remoteAddress }
  val pendingGatewayTrust: StateFlow<NodeRuntime.GatewayTrustPrompt?> = runtimeState(initial = null) { it.pendingGatewayTrust }
  val seamColorArgb: StateFlow<Long> = runtimeState(initial = 0xFF0EA5E9) { it.seamColorArgb }
  val mainSessionKey: StateFlow<String> = runtimeState(initial = "main") { it.mainSessionKey }

  val cameraHud: StateFlow<CameraHudState?> = runtimeState(initial = null) { it.cameraHud }
  val cameraFlashToken: StateFlow<Long> = runtimeState(initial = 0L) { it.cameraFlashToken }

  val instanceId: StateFlow<String> = prefs.instanceId
  val displayName: StateFlow<String> = prefs.displayName
  val cameraEnabled: StateFlow<Boolean> = prefs.cameraEnabled
  val locationMode: StateFlow<LocationMode> = prefs.locationMode
  val locationPreciseEnabled: StateFlow<Boolean> = prefs.locationPreciseEnabled
  val preventSleep: StateFlow<Boolean> = prefs.preventSleep
  val manualEnabled: StateFlow<Boolean> = prefs.manualEnabled
  val manualHost: StateFlow<String> = prefs.manualHost
  val manualPort: StateFlow<Int> = prefs.manualPort
  val manualTls: StateFlow<Boolean> = prefs.manualTls
  val gatewayToken: StateFlow<String> = prefs.gatewayToken
  val gatewayBootstrapToken: StateFlow<String> = prefs.gatewayBootstrapToken
  val onboardingCompleted: StateFlow<Boolean> = prefs.onboardingCompleted
  val canvasDebugStatusEnabled: StateFlow<Boolean> = prefs.canvasDebugStatusEnabled
  val speakerEnabled: StateFlow<Boolean> = prefs.speakerEnabled
  val voiceCaptureMode: StateFlow<VoiceCaptureMode> = runtimeState(initial = VoiceCaptureMode.Off) { it.voiceCaptureMode }
  val micEnabled: StateFlow<Boolean> = runtimeState(initial = false) { it.micEnabled }

  val micCooldown: StateFlow<Boolean> = runtimeState(initial = false) { it.micCooldown }
  val micStatusText: StateFlow<String> = runtimeState(initial = "Mic off") { it.micStatusText }
  val micLiveTranscript: StateFlow<String?> = runtimeState(initial = null) { it.micLiveTranscript }
  val micIsListening: StateFlow<Boolean> = runtimeState(initial = false) { it.micIsListening }
  val micQueuedMessages: StateFlow<List<String>> = runtimeState(initial = emptyList()) { it.micQueuedMessages }
  val micConversation: StateFlow<List<VoiceConversationEntry>> = runtimeState(initial = emptyList()) { it.micConversation }
  val micInputLevel: StateFlow<Float> = runtimeState(initial = 0f) { it.micInputLevel }
  val micIsSending: StateFlow<Boolean> = runtimeState(initial = false) { it.micIsSending }
  val talkModeEnabled: StateFlow<Boolean> = runtimeState(initial = false) { it.talkModeEnabled }
  val talkModeListening: StateFlow<Boolean> = runtimeState(initial = false) { it.talkModeListening }
  val talkModeSpeaking: StateFlow<Boolean> = runtimeState(initial = false) { it.talkModeSpeaking }
  val talkModeStatusText: StateFlow<String> = runtimeState(initial = "Off") { it.talkModeStatusText }

  val chatSessionKey: StateFlow<String> = runtimeState(initial = "main") { it.chatSessionKey }
  val chatSessionId: StateFlow<String?> = runtimeState(initial = null) { it.chatSessionId }
  val chatMessages: StateFlow<List<ChatMessage>> = runtimeState(initial = emptyList()) { it.chatMessages }
  val chatError: StateFlow<String?> = runtimeState(initial = null) { it.chatError }
  val chatHealthOk: StateFlow<Boolean> = runtimeState(initial = false) { it.chatHealthOk }
  val chatThinkingLevel: StateFlow<String> = runtimeState(initial = "off") { it.chatThinkingLevel }
  val chatStreamingAssistantText: StateFlow<String?> = runtimeState(initial = null) { it.chatStreamingAssistantText }
  val chatPendingToolCalls: StateFlow<List<ChatPendingToolCall>> = runtimeState(initial = emptyList()) { it.chatPendingToolCalls }
  val chatSessions: StateFlow<List<ChatSessionEntry>> = runtimeState(initial = emptyList()) { it.chatSessions }
  val pendingRunCount: StateFlow<Int> = runtimeState(initial = 0) { it.pendingRunCount }

  init {
    if (prefs.onboardingCompleted.value) {
      ensureRuntime()
    }
  }

  // FORK 2026-10-19 (the architect: phone app) — Jarvis door pairing and the Tinker home screen.
  val jarvisPaired: StateFlow<Boolean> = prefs.jarvisPaired
  val jarvisDoorCandidates: StateFlow<List<String>> = prefs.jarvisDoorCandidates
  val jarvisDoorOrigin: StateFlow<String?> = JarvisDoor.origin
  private val _jarvisScreen = MutableStateFlow(JarvisScreen.Tinker)
  val jarvisScreen: StateFlow<JarvisScreen> = _jarvisScreen
  private val _jarvisPairGeneration = MutableStateFlow(0)

  /** Bumped by every new pairing, so a WebView that is already open picks up the new token. */
  val jarvisPairGeneration: StateFlow<Int> = _jarvisPairGeneration
  private val _pendingJarvisPair = MutableStateFlow<JarvisPairLink?>(null)
  val pendingJarvisPair: StateFlow<JarvisPairLink?> = _pendingJarvisPair

  fun openJarvisScreen(screen: JarvisScreen) {
    _jarvisScreen.value = screen
  }

  fun jarvisDeviceToken(): String? = prefs.loadJarvisDeviceToken()

  /** Parses a pair link with this phone's own door list as the "known doors". */
  fun parseJarvisPairLinkHere(raw: String?) = parseJarvisPairLink(raw, knownDoors = prefs.jarvisDoorCandidates.value + defaultJarvisDoorCandidates)

  /** The door this phone is paired with now (null when not paired), for the "replaces" warning. */
  fun currentJarvisDoor(): String? {
    if (!prefs.jarvisPaired.value) return null
    return JarvisDoor.origin.value ?: prefs.jarvisDoorCandidates.value.firstOrNull()
  }

  /** A jarvis://pair link from outside the app (deep link): parked until the user confirms it. */
  fun offerJarvisPairLink(raw: String?): String? {
    val parsed = parseJarvisPairLinkHere(raw)
    val link = parsed.link ?: return parsed.error
    _pendingJarvisPair.value = link
    return null
  }

  fun confirmJarvisPair() {
    val link = _pendingJarvisPair.value ?: return
    _pendingJarvisPair.value = null
    applyJarvisPairLink(link)
  }

  fun dismissJarvisPair() {
    _pendingJarvisPair.value = null
  }

  /** Stores the door and both tokens, then points the node's gateway connection at the door. */
  fun applyJarvisPairLink(link: JarvisPairLink) {
    prefs.setJarvisDoorCandidates(withDoorFirst(link.doorOrigin, prefs.jarvisDoorCandidates.value))
    ensureRuntime().resetGatewaySetupAuth()
    prefs.saveJarvisDeviceToken(link.deviceToken)
    prefs.setGatewayToken(link.gatewayToken)
    _jarvisScreen.value = JarvisScreen.Tinker
    _jarvisPairGeneration.value += 1
    pointNodeAtDoor(link.doorOrigin)
  }

  /** Comma or newline separated door addresses; returns an error message or null when saved. */
  fun setJarvisDoorCandidates(text: String): String? {
    val raw = text.split(',', '\n').map { it.trim() }.filter { it.isNotEmpty() }
    if (raw.isEmpty()) return "Add at least one door address."
    val origins = mutableListOf<String>()
    for (entry in raw) {
      val origin = normalizeJarvisDoorOrigin(entry) ?: return "Not an address: $entry"
      val host = jarvisDoorHostPort(origin)?.first
      if (!isAllowedJarvisDoorHost(host)) return "Not a Tailscale address: $entry"
      origins += origin
    }
    prefs.setJarvisDoorCandidates(origins.distinct())
    return null
  }

  /** Probes the candidates; when the answering door is not the one the node uses, moves the node. */
  suspend fun resolveJarvisDoor(): String? {
    val origin = JarvisDoor.resolve(prefs.jarvisDoorCandidates.value) ?: return null
    val (host, port) = jarvisDoorHostPort(origin) ?: return origin
    val nodeOnDoor = prefs.manualEnabled.value && prefs.manualHost.value == host && prefs.manualPort.value == port
    if (!nodeOnDoor && prefs.loadJarvisDeviceToken() != null) {
      pointNodeAtDoor(origin)
    }
    return origin
  }

  fun connectJarvisDoor() {
    val origin = JarvisDoor.origin.value ?: prefs.jarvisDoorCandidates.value.firstOrNull() ?: return
    pointNodeAtDoor(origin)
  }

  private fun pointNodeAtDoor(origin: String) {
    val (host, port) = jarvisDoorHostPort(origin) ?: return
    prefs.setManualEnabled(true)
    prefs.setManualHost(host)
    prefs.setManualPort(port)
    prefs.setManualTls(origin.startsWith("https://"))
    ensureRuntime().connect(GatewayEndpoint.manual(host = host, port = port))
  }

  val canvas: CanvasController
    get() = ensureRuntime().canvas

  val camera: CameraCaptureManager
    get() = ensureRuntime().camera

  val sms: SmsManager
    get() = ensureRuntime().sms

  fun attachRuntimeUi(
    owner: LifecycleOwner,
    permissionRequester: PermissionRequester,
  ) {
    val runtime = runtimeRef.value ?: return
    runtime.camera.attachLifecycleOwner(owner)
    runtime.camera.attachPermissionRequester(permissionRequester)
    runtime.sms.attachPermissionRequester(permissionRequester)
  }

  fun setForeground(value: Boolean) {
    foreground = value
    val runtime =
      if (value && prefs.onboardingCompleted.value) {
        ensureRuntime()
      } else {
        runtimeRef.value
      }
    runtime?.setForeground(value)
  }

  fun setDisplayName(value: String) {
    prefs.setDisplayName(value)
  }

  fun setCameraEnabled(value: Boolean) {
    prefs.setCameraEnabled(value)
  }

  fun setLocationMode(mode: LocationMode) {
    prefs.setLocationMode(mode)
  }

  fun setLocationPreciseEnabled(value: Boolean) {
    prefs.setLocationPreciseEnabled(value)
  }

  fun setPreventSleep(value: Boolean) {
    prefs.setPreventSleep(value)
  }

  fun setManualEnabled(value: Boolean) {
    prefs.setManualEnabled(value)
  }

  fun setManualHost(value: String) {
    prefs.setManualHost(value)
  }

  fun setManualPort(value: Int) {
    prefs.setManualPort(value)
  }

  fun setManualTls(value: Boolean) {
    prefs.setManualTls(value)
  }

  fun setGatewayToken(value: String) {
    prefs.setGatewayToken(value)
  }

  fun setGatewayBootstrapToken(value: String) {
    prefs.setGatewayBootstrapToken(value)
  }

  fun setGatewayPassword(value: String) {
    prefs.setGatewayPassword(value)
  }

  fun resetGatewaySetupAuth() {
    ensureRuntime().resetGatewaySetupAuth()
  }

  fun setOnboardingCompleted(value: Boolean) {
    if (value) {
      ensureRuntime()
    }
    prefs.setOnboardingCompleted(value)
  }

  fun setCanvasDebugStatusEnabled(value: Boolean) {
    prefs.setCanvasDebugStatusEnabled(value)
  }

  fun setNotificationForwardingEnabled(value: Boolean) {
    ensureRuntime().setNotificationForwardingEnabled(value)
  }

  fun setNotificationForwardingMode(mode: NotificationPackageFilterMode) {
    ensureRuntime().setNotificationForwardingMode(mode)
  }

  fun setNotificationForwardingPackagesCsv(csv: String) {
    val packages =
      csv
        .split(',')
        .map { it.trim() }
        .filter { it.isNotEmpty() }
    ensureRuntime().setNotificationForwardingPackages(packages)
  }

  fun setNotificationForwardingQuietHours(
    enabled: Boolean,
    start: String,
    end: String,
  ): Boolean = ensureRuntime().setNotificationForwardingQuietHours(enabled = enabled, start = start, end = end)

  fun setNotificationForwardingMaxEventsPerMinute(value: Int) {
    ensureRuntime().setNotificationForwardingMaxEventsPerMinute(value)
  }

  fun setNotificationForwardingSessionKey(value: String?) {
    ensureRuntime().setNotificationForwardingSessionKey(value)
  }

  fun setVoiceScreenActive(active: Boolean) {
    ensureRuntime().setVoiceScreenActive(active)
  }

  fun handleAssistantLaunch(request: AssistantLaunchRequest) {
    _requestedHomeDestination.value = HomeDestination.Chat
    if (request.autoSend) {
      _pendingAssistantAutoSend.value = request.prompt
      _chatDraft.value = null
      return
    }
    _pendingAssistantAutoSend.value = null
    _chatDraft.value = request.prompt
  }

  fun clearRequestedHomeDestination() {
    _requestedHomeDestination.value = null
  }

  fun clearChatDraft() {
    _chatDraft.value = null
  }

  fun clearPendingAssistantAutoSend() {
    _pendingAssistantAutoSend.value = null
  }

  fun setMicEnabled(enabled: Boolean) {
    ensureRuntime().setMicEnabled(enabled)
  }

  fun setTalkModeEnabled(enabled: Boolean) {
    ensureRuntime().setTalkModeEnabled(enabled)
  }

  fun setSpeakerEnabled(enabled: Boolean) {
    ensureRuntime().setSpeakerEnabled(enabled)
  }

  fun refreshGatewayConnection() {
    ensureRuntime().refreshGatewayConnection()
  }

  fun connect(endpoint: GatewayEndpoint) {
    ensureRuntime().connect(endpoint)
  }

  fun connect(
    endpoint: GatewayEndpoint,
    token: String?,
    bootstrapToken: String?,
    password: String?,
  ) {
    ensureRuntime().connect(
      endpoint,
      NodeRuntime.GatewayConnectAuth(
        token = token,
        bootstrapToken = bootstrapToken,
        password = password,
      ),
    )
  }

  fun connectManual() {
    ensureRuntime().connectManual()
  }

  fun disconnect() {
    runtimeRef.value?.disconnect()
  }

  fun acceptGatewayTrustPrompt() {
    runtimeRef.value?.acceptGatewayTrustPrompt()
  }

  fun declineGatewayTrustPrompt() {
    runtimeRef.value?.declineGatewayTrustPrompt()
  }

  fun handleCanvasA2UIActionFromWebView(payloadJson: String) {
    ensureRuntime().handleCanvasA2UIActionFromWebView(payloadJson)
  }

  fun isTrustedCanvasActionUrl(rawUrl: String?): Boolean = ensureRuntime().isTrustedCanvasActionUrl(rawUrl)

  fun requestCanvasRehydrate(source: String = "screen_tab") {
    ensureRuntime().requestCanvasRehydrate(source = source, force = true)
  }

  fun refreshHomeCanvasOverviewIfConnected() {
    ensureRuntime().refreshHomeCanvasOverviewIfConnected()
  }

  fun loadChat(sessionKey: String) {
    ensureRuntime().loadChat(sessionKey)
  }

  fun refreshChat() {
    ensureRuntime().refreshChat()
  }

  fun refreshChatSessions(limit: Int? = null) {
    ensureRuntime().refreshChatSessions(limit = limit)
  }

  fun setChatThinkingLevel(level: String) {
    ensureRuntime().setChatThinkingLevel(level)
  }

  fun switchChatSession(sessionKey: String) {
    ensureRuntime().switchChatSession(sessionKey)
  }

  fun abortChat() {
    ensureRuntime().abortChat()
  }

  fun sendChat(
    message: String,
    thinking: String,
    attachments: List<OutgoingAttachment>,
  ) {
    ensureRuntime().sendChat(message = message, thinking = thinking, attachments = attachments)
  }

  suspend fun sendChatAwaitAcceptance(
    message: String,
    thinking: String,
    attachments: List<OutgoingAttachment>,
  ): Boolean =
    ensureRuntime().sendChatAwaitAcceptance(
      message = message,
      thinking = thinking,
      attachments = attachments,
    )
}
