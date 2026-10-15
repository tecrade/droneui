import { useState, useEffect, useRef, useCallback } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine
} from 'recharts'
import './index.css'

const FASTAPI_URL = typeof window !== 'undefined' && window.location.hostname
  ? `${window.location.protocol}//${window.location.hostname}:8001`
  : 'http://localhost:8001'
const DIRECT_URL  = 'http://192.168.4.1'
const PROXY_URL   = '/api'
const POLL_MS     = 200          // 5 Hz polling
const MAX_HISTORY = 120          // data points retained

/* ─── Helper: Robust ESP32 Response Parser ────────────────── */
/**
 * ESP32 telemetry string may arrive as:
 *   response-{"roll":-0.28,"pitch":-0.19,"yawrate":-0.02,"desiredRoll":2.01,"desiredPitch":0.00,"desiredYawRate":0.00,"rollError":2.29,"pitchError":0.19,"yawError":0.02,"rollKp":5.00,"pitchKp":5.00,"yawKp":2.00,"rollKi":0.00,"pitchKi":0.00,"yawKi":0.00,"rollKd":0.00,"pitchKd":0.00,"yawKd":0.00,"rollPID":11.47,"pitchPID":0.97,"yawPID":0.04,"leftMotorPWM":1000,"rightMotorPWM":1000,"leftServoPWM":1500,"rightServoPWM":1500,"pitchServoScale":100,"yawServoScale":100,"armed":false}
 */
function parseEsp32Telemetry(input) {
  if (!input) throw new Error('Empty response')

  let rawData = input
  if (typeof input === 'string') {
    let clean = input.trim()
    if (clean.startsWith('response-')) {
      clean = clean.substring(9).trim()
    }
    // Replace unquoted inf, -inf, nan, ovf with 0.0
    clean = clean.replace(/:\s*(-?inf|-?nan|ovf)\b/gi, ': 0.0')
    try {
      rawData = JSON.parse(clean)
    } catch {
      // Repair missing commas between key-value pairs (e.g. 2.00"rollPID" -> 2.00,"rollPID")
      clean = clean.replace(/([0-9a-zA-Z.-]+)"([a-zA-Z0-9_]+)":/g, '$1,"$2":')
      rawData = JSON.parse(clean)
    }
  }

  const merged = {
    roll: 0, pitch: 0, yawrate: 0,
    desiredRoll: 0, desiredPitch: 0, desiredYawRate: 0,
    rollError: 0, pitchError: 0, yawError: 0,
    rollKp: 5, pitchKp: 5, yawKp: 2,
    rollKi: 0, pitchKi: 0, yawKi: 0,
    rollKd: 0, pitchKd: 0, yawKd: 0,
    rollPID: 0, pitchPID: 0, yawPID: 0,
    leftMotorPWM: 1000, rightMotorPWM: 1000,
    leftServoPWM: 1500, rightServoPWM: 1500,
    pitchServoScale: 100, yawServoScale: 100,
    armed: false,
    ...(typeof rawData === 'object' && rawData !== null ? rawData : {})
  }

  // Ensure all numeric fields are finite numbers
  for (const k in merged) {
    if (typeof merged[k] === 'number' && !Number.isFinite(merged[k])) {
      merged[k] = 0
    }
  }

  return merged
}

function clamp(v, min, max) { return Math.min(Math.max(v, min), max) }
function fmt(v, d = 2) { return (typeof v === 'number' ? v : 0).toFixed(d) }
function pct(v, range = 30) { return clamp(50 + (v / range) * 50, 0, 100) }

/* ─── Custom Tooltip ──────────────────────────────────────── */
function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'rgba(13,20,34,0.95)',
      border: '1px solid rgba(99,179,237,0.25)',
      borderRadius: 10,
      padding: '10px 14px',
      fontSize: '0.75rem',
      fontFamily: 'var(--font-mono)',
      color: 'var(--text-secondary)',
      boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
    }}>
      <div style={{ marginBottom: 6, color: 'var(--text-muted)', fontSize: '0.65rem' }}>
        t={label}s
      </div>
      {payload.map(p => (
        <div key={p.dataKey} style={{ color: p.color, marginBottom: 2 }}>
          {p.name}: <strong>{fmt(p.value)}</strong>
        </div>
      ))}
    </div>
  )
}

/* ─── Attitude Indicator ──────────────────────────────────── */
function AttitudeIndicator({ roll, pitch }) {
  const pitchPx = clamp(pitch * 2, -50, 50)
  return (
    <div className="attitude-indicator">
      <div className="ai-horizon" style={{
        transform: `rotate(${-roll}deg) translateY(${pitchPx}px)`
      }}>
        <div className="ai-sky" />
        <div className="ai-ground" />
        <div className="ai-horizon-line" />
      </div>
      <div className="ai-overlay">
        <div className="ai-crosshair" />
        <div className="ai-wings">
          <div className="ai-wing" />
          <div className="ai-center-dot" />
          <div className="ai-wing" />
        </div>
      </div>
    </div>
  )
}

/* ─── Drone Top-View SVG ─────────────────────────────────── */
function DroneTopView({ yawRate }) {
  const rotRef  = useRef(0)
  const [rot, setRot] = useState(0)

  useEffect(() => {
    rotRef.current += yawRate * 0.2
    setRot(rotRef.current)
  }, [yawRate])

  return (
    <div className="drone-top-view">
      <svg width="140" height="140" viewBox="0 0 140 140" className="drone-svg"
        style={{ transform: `rotate(${rot}deg)`, transition: 'transform 0.12s ease-out' }}>
        <circle cx="70" cy="70" r="66" fill="none" stroke="rgba(99,179,237,0.15)" strokeWidth="1" />
        <text x="70" y="10" textAnchor="middle" fill="rgba(99,179,237,0.5)" fontSize="9" fontFamily="var(--font-mono)">N</text>
        {[[-1,-1],[1,-1],[1,1],[-1,1]].map(([sx,sy], i) => (
          <line key={i}
            x1="70" y1="70"
            x2={70 + sx*30} y2={70 + sy*30}
            stroke="rgba(148,163,184,0.5)" strokeWidth="3" strokeLinecap="round"
          />
        ))}
        {[[-1,-1],[1,-1],[1,1],[-1,1]].map(([sx,sy], i) => (
          <g key={i}>
            <circle cx={70+sx*32} cy={70+sy*32} r="13"
              fill="rgba(13,20,34,0.9)"
              stroke={['#38bdf8','#4ade80','#f472b6','#fbbf24'][i]}
              strokeWidth="2"
            />
            <circle cx={70+sx*32} cy={70+sy*32} r="7"
              fill={['rgba(56,189,248,0.2)','rgba(74,222,128,0.2)','rgba(244,114,182,0.2)','rgba(251,191,36,0.2)'][i]}
            />
          </g>
        ))}
        <rect x="58" y="58" width="24" height="24" rx="6"
          fill="#1e293b" stroke="rgba(99,179,237,0.5)" strokeWidth="1.5"
        />
        <circle cx="70" cy="70" r="4" fill="#38bdf8"
          style={{ filter: 'drop-shadow(0 0 6px #38bdf8)' }}
        />
        <polygon points="70,46 65,56 75,56" fill="#fbbf24"
          style={{ filter: 'drop-shadow(0 0 5px #fbbf24)' }}
        />
      </svg>
    </div>
  )
}

/* ─── Progress Slider Bar ────────────────────────────────── */
function ProgressBar({ label, value, range, color, unit = '°' }) {
  const percent = pct(value, range)
  const isNeg   = value < 0
  return (
    <div className="slider-row">
      <div className="slider-row-header">
        <span className="slider-label">
          <span className="slider-label-dot" style={{ background: color }} />
          {label}
        </span>
        <span className="slider-value" style={{ color }}>
          {fmt(value)}{unit}
        </span>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{
          width: `${percent}%`,
          background: isNeg
            ? `linear-gradient(90deg, transparent, ${color}88, ${color})`
            : `linear-gradient(90deg, ${color}55, ${color})`,
        }} />
      </div>
    </div>
  )
}

/* ─── Single Axis Mini Chart ─────────────────────────────── */
function AxisChart({ title, dataKey, data, color, unit = '°', yDomain }) {
  return (
    <div className="card" style={{ padding: '16px' }}>
      <div className="card-title">
        <span className="card-title-dot" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
        {title}
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: '0.9rem', color }}>
          {fmt(data[data.length - 1]?.[dataKey] ?? 0)}{unit}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={120}>
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="t" hide />
          <YAxis domain={yDomain ?? ['auto', 'auto']} tickCount={5} />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.1)" />
          <Line
            type="monotoneX"
            dataKey={dataKey}
            stroke={color}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            name={title}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

/* ─── Armed Status Badge ─────────────────────────────────── */
function ArmedBadge({ armed }) {
  return (
    <div className={`armed-badge ${armed ? 'armed' : 'disarmed'}`}>
      <span className="armed-dot" />
      {armed ? 'Armed' : 'Disarmed'}
    </div>
  )
}

/* ─── Actuator Outputs Panel (Motors & Servos) ───────────── */
function ActuatorPanel({ leftMotor, rightMotor, leftServo, rightServo }) {
  const motorPct = (val) => clamp(((val - 1000) / 1000) * 100, 0, 100)
  const servoPct = (val) => clamp(((val - 1000) / 1000) * 100, 0, 100)

  return (
    <div className="actuator-group">
      {/* Motors */}
      <div className="actuator-row">
        <div className="actuator-header">
          <span className="actuator-title">⚡ Left Motor PWM</span>
          <span className="actuator-val" style={{ color: 'var(--accent-blue)' }}>{leftMotor} µs</span>
        </div>
        <div className="pwm-bar-track">
          <div className="pwm-bar-fill" style={{
            width: `${motorPct(leftMotor)}%`,
            background: 'linear-gradient(90deg, var(--accent-blue), var(--accent-cyan))'
          }} />
        </div>
      </div>

      <div className="actuator-row">
        <div className="actuator-header">
          <span className="actuator-title">⚡ Right Motor PWM</span>
          <span className="actuator-val" style={{ color: 'var(--accent-blue)' }}>{rightMotor} µs</span>
        </div>
        <div className="pwm-bar-track">
          <div className="pwm-bar-fill" style={{
            width: `${motorPct(rightMotor)}%`,
            background: 'linear-gradient(90deg, var(--accent-blue), var(--accent-cyan))'
          }} />
        </div>
      </div>

      {/* Servos */}
      <div className="actuator-row" style={{ marginTop: 6 }}>
        <div className="actuator-header">
          <span className="actuator-title">🎯 Left Servo PWM</span>
          <span className="actuator-val" style={{ color: 'var(--accent-green)' }}>{leftServo} µs</span>
        </div>
        <div className="pwm-bar-track">
          <div className="pwm-center-line" />
          <div className="pwm-bar-fill" style={{
            width: `${servoPct(leftServo)}%`,
            background: 'linear-gradient(90deg, var(--accent-green), var(--accent-yellow))'
          }} />
        </div>
      </div>

      <div className="actuator-row">
        <div className="actuator-header">
          <span className="actuator-title">🎯 Right Servo PWM</span>
          <span className="actuator-val" style={{ color: 'var(--accent-green)' }}>{rightServo} µs</span>
        </div>
        <div className="pwm-bar-track">
          <div className="pwm-center-line" />
          <div className="pwm-bar-fill" style={{
            width: `${servoPct(rightServo)}%`,
            background: 'linear-gradient(90deg, var(--accent-green), var(--accent-yellow))'
          }} />
        </div>
      </div>
    </div>
  )
}

/* ─── Servo Scale Control Panel ──────────────────────────── */
function ServoScalePanel({ currentPitch, currentYaw, getServoScaleUrl, onUpdate }) {
  const [pitch, setPitch] = useState('')
  const [yaw, setYaw]     = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async () => {
    const pVal = parseInt(pitch || currentPitch, 10)
    const yVal = parseInt(yaw || currentYaw, 10)
    if (isNaN(pVal) || isNaN(yVal)) return

    setLoading(true)
    try {
      const baseUrl = getServoScaleUrl()
      const url = `${baseUrl}?pitch=${pVal}&yaw=${yVal}`
      const res = await fetch(url)
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const text = await res.text()
      onUpdate('success', `Servo Scale Updated (${text.trim()}) → Pitch:${pVal} Yaw:${yVal}`)
      setPitch(''); setYaw('')
    } catch (e) {
      onUpdate('error', 'Failed to update Servo Scale: ' + e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="servo-scale-grid">
      <div className="kp-field">
        <label className="kp-label">
          Pitch Scale
          <span className="kp-current">current: {currentPitch}</span>
        </label>
        <div className="kp-input-wrapper">
          <input
            type="number"
            className="kp-input"
            placeholder={currentPitch}
            value={pitch}
            onChange={e => setPitch(e.target.value)}
          />
        </div>
      </div>

      <div className="kp-field">
        <label className="kp-label">
          Yaw Scale
          <span className="kp-current">current: {currentYaw}</span>
        </label>
        <div className="kp-input-wrapper">
          <input
            type="number"
            className="kp-input"
            placeholder={currentYaw}
            value={yaw}
            onChange={e => setYaw(e.target.value)}
          />
        </div>
      </div>

      <button
        className="kp-submit-btn"
        onClick={handleSubmit}
        disabled={loading}
      >
        {loading ? <SpinIcon /> : '✦ Update Scale'}
      </button>
    </div>
  )
}

/* ─── Active PID Gains Matrix ────────────────────────────── */
function PidGainsMatrix({ tele }) {
  return (
    <table className="pid-matrix-table">
      <thead>
        <tr>
          <th>Axis</th>
          <th style={{ color: 'var(--accent-cyan)' }}>Kp</th>
          <th style={{ color: 'var(--accent-purple)' }}>Ki</th>
          <th style={{ color: 'var(--accent-yellow)' }}>Kd</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style={{ color: 'var(--color-roll)' }}>Roll</td>
          <td>{fmt(tele.rollKp, 3)}</td>
          <td>{fmt(tele.rollKi, 3)}</td>
          <td>{fmt(tele.rollKd, 3)}</td>
        </tr>
        <tr>
          <td style={{ color: 'var(--color-pitch)' }}>Pitch</td>
          <td>{fmt(tele.pitchKp, 3)}</td>
          <td>{fmt(tele.pitchKi, 3)}</td>
          <td>{fmt(tele.pitchKd, 3)}</td>
        </tr>
        <tr>
          <td style={{ color: 'var(--color-yaw)' }}>Yaw</td>
          <td>{fmt(tele.yawKp, 3)}</td>
          <td>{fmt(tele.yawKi, 3)}</td>
          <td>{fmt(tele.yawKd, 3)}</td>
        </tr>
      </tbody>
    </table>
  )
}

/* ─── PID Gain Tuning Studio (Kp, Ki, Kd) ───────────────── */
function PidTuningStudio({ tele, getKpUrl, getKiUrl, getKdUrl, onUpdate }) {
  const [activeTab, setActiveTab] = useState('kp') // 'kp' | 'ki' | 'kd'
  const [rollVal, setRollVal]   = useState('')
  const [pitchVal, setPitchVal] = useState('')
  const [yawVal, setYawVal]     = useState('')
  const [loading, setLoading]   = useState(false)

  const getCurrentVals = () => {
    if (activeTab === 'kp') return { roll: tele.rollKp, pitch: tele.pitchKp, yaw: tele.yawKp }
    if (activeTab === 'ki') return { roll: tele.rollKi, pitch: tele.pitchKi, yaw: tele.yawKi }
    return { roll: tele.rollKd, pitch: tele.pitchKd, yaw: tele.yawKd }
  }

  const cur = getCurrentVals()

  const handleSubmit = async () => {
    const roll  = parseFloat(rollVal  || cur.roll)
    const pitch = parseFloat(pitchVal || cur.pitch)
    const yaw   = parseFloat(yawVal   || cur.yaw)
    if (isNaN(roll) || isNaN(pitch) || isNaN(yaw)) return

    setLoading(true)
    try {
      const getUrlFn = activeTab === 'kp' ? getKpUrl : activeTab === 'ki' ? getKiUrl : getKdUrl
      const baseUrl = getUrlFn()
      const url = `${baseUrl}?roll=${roll}&pitch=${pitch}&yaw=${yaw}`
      const res = await fetch(url)
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const resText = await res.text()
      onUpdate('success', `${activeTab.toUpperCase()} updated (${resText.trim()}) → Roll:${roll} Pitch:${pitch} Yaw:${yaw}`)
      setRollVal(''); setPitchVal(''); setYawVal('')
    } catch (e) {
      onUpdate('error', `Failed to update ${activeTab.toUpperCase()}: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  const fields = [
    { key: 'roll',  label: `Roll ${activeTab.toUpperCase()}`,  color: 'var(--color-roll)',  val: rollVal,  set: setRollVal,  cur: cur.roll },
    { key: 'pitch', label: `Pitch ${activeTab.toUpperCase()}`, color: 'var(--color-pitch)', val: pitchVal, set: setPitchVal, cur: cur.pitch },
    { key: 'yaw',   label: `Yaw ${activeTab.toUpperCase()}`,   color: 'var(--color-yaw)',   val: yawVal,   set: setYawVal,   cur: cur.yaw },
  ]

  return (
    <div>
      {/* Tabs */}
      <div className="pid-tabs">
        {[
          { id: 'kp', label: 'Proportional (Kp)' },
          { id: 'ki', label: 'Integral (Ki)' },
          { id: 'kd', label: 'Derivative (Kd)' },
        ].map(t => (
          <button
            key={t.id}
            className={`pid-tab-btn ${activeTab === t.id ? 'active' : ''}`}
            onClick={() => {
              setActiveTab(t.id)
              setRollVal(''); setPitchVal(''); setYawVal('')
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="kp-form">
        {fields.map(f => (
          <div className="kp-field" key={f.key}>
            <label className="kp-label" htmlFor={`tune-${f.key}`}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: f.color, display:'inline-block', boxShadow:`0 0 8px ${f.color}` }} />
              {f.label}
              <span className="kp-current">current: {fmt(f.cur, 3)}</span>
            </label>
            <div className="kp-input-wrapper">
              <input
                id={`tune-${f.key}`}
                type="number"
                step="0.01"
                min="0"
                max="50"
                className="kp-input"
                placeholder={fmt(f.cur, 3)}
                value={f.val}
                onChange={e => f.set(e.target.value)}
                style={{ borderColor: f.val ? f.color : undefined }}
              />
            </div>
          </div>
        ))}
        <button
          className="kp-submit-btn"
          onClick={handleSubmit}
          disabled={loading}
        >
          {loading ? (
            <>
              <SpinIcon /> Sending…
            </>
          ) : (
            <>
              ✦ Update {activeTab.toUpperCase()}
            </>
          )}
        </button>
      </div>
    </div>
  )
}

function SpinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5"
      style={{ animation: 'spin 0.8s linear infinite' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" opacity="0.2"/>
      <path d="M21 12a9 9 0 00-9-9"/>
    </svg>
  )
}

/* ─── Toast ──────────────────────────────────────────────── */
function Toast({ msg, type, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3200)
    return () => clearTimeout(t)
  }, [onDone])

  return (
    <div className={`toast ${type}`}>
      <span>{type === 'success' ? '✓' : '✕'}</span>
      {msg}
    </div>
  )
}

/* ─── Main App ───────────────────────────────────────────── */
export default function App() {
  const [mode, setMode]       = useState('fastapi') // 'fastapi' | 'direct' | 'proxy' | 'demo'
  const [tele, setTele]       = useState({
    roll: 0, pitch: 0, yawrate: 0,
    desiredRoll: 0, desiredPitch: 0, desiredYawRate: 0,
    rollError: 0, pitchError: 0, yawError: 0,
    rollKp: 5, pitchKp: 5, yawKp: 2,
    rollKi: 0, pitchKi: 0, yawKi: 0,
    rollKd: 0, pitchKd: 0, yawKd: 0,
    rollPID: 0, pitchPID: 0, yawPID: 0,
    leftMotorPWM: 1000, rightMotorPWM: 1000,
    leftServoPWM: 1500, rightServoPWM: 1500,
    pitchServoScale: 100, yawServoScale: 100,
    armed: false,
  })
  const [history,   setHistory]   = useState([])
  const [connected, setConnected] = useState(false)
  const [statusMsg, setStatusMsg] = useState('Initializing...')
  const [toast,     setToast]     = useState(null)
  const [freq,      setFreq]      = useState(0)

  const tickRef   = useRef(0)
  const lastOkRef = useRef(0)
  const simAngle  = useRef(0)

  const discoveredFastApiUrlRef = useRef(FASTAPI_URL)
  const failCountRef = useRef(0)

  const getTelemetryUrl = useCallback((m = mode) => {
    if (m === 'fastapi') return `${discoveredFastApiUrlRef.current}/telemetry`
    if (m === 'direct')  return `${DIRECT_URL}/telemetry`
    if (m === 'proxy')   return `${PROXY_URL}/telemetry`
    return `${discoveredFastApiUrlRef.current}/telemetry`
  }, [mode])

  const getKpUrl = useCallback(() => {
    if (mode === 'fastapi') return `${discoveredFastApiUrlRef.current}/kp`
    if (mode === 'direct')  return `${DIRECT_URL}/kp`
    return `${PROXY_URL}/kp`
  }, [mode])

  const getKiUrl = useCallback(() => {
    if (mode === 'fastapi') return `${discoveredFastApiUrlRef.current}/ki`
    if (mode === 'direct')  return `${DIRECT_URL}/ki`
    return `${PROXY_URL}/ki`
  }, [mode])

  const getKdUrl = useCallback(() => {
    if (mode === 'fastapi') return `${discoveredFastApiUrlRef.current}/kd`
    if (mode === 'direct')  return `${DIRECT_URL}/kd`
    return `${PROXY_URL}/kd`
  }, [mode])

  const getServoScaleUrl = useCallback(() => {
    if (mode === 'fastapi') return `${discoveredFastApiUrlRef.current}/servoScale`
    if (mode === 'direct')  return `${DIRECT_URL}/servoScale`
    return `${PROXY_URL}/servoScale`
  }, [mode])

  /* ── Simulated Flight (Demo Mode) ── */
  const runDemoStep = useCallback(() => {
    simAngle.current += 0.08
    const a = simAngle.current
    const r  = Math.sin(a) * 12
    const p  = Math.cos(a * 0.7) * 8
    const yr = Math.sin(a * 1.3) * 25
    const dr = Math.sin(a * 0.5) * 10
    const dp = Math.cos(a * 0.4) * 6
    const dy = Math.cos(a * 0.9) * 20

    const errR = dr - r
    const errP = dp - p
    const errY = dy - yr

    const rPid = errR * 6.5
    const pPid = errP * 6.5
    const yPid = errY * 2.2

    const baseThrottle = 1450
    const leftMotor  = Math.round(clamp(baseThrottle + rPid * 4 + pPid * 2, 1000, 2000))
    const rightMotor = Math.round(clamp(baseThrottle - rPid * 4 + pPid * 2, 1000, 2000))
    const leftServo  = Math.round(clamp(1500 + pPid * 5, 1000, 2000))
    const rightServo = Math.round(clamp(1500 + yPid * 3, 1000, 2000))

    const data = {
      roll: r, pitch: p, yawrate: yr,
      desiredRoll: dr, desiredPitch: dp, desiredYawRate: dy,
      rollError: errR, pitchError: errP, yawError: errY,
      rollKp: 6.5, pitchKp: 6.5, yawKp: 2.2,
      rollKi: 0.15, pitchKi: 0.15, yawKi: 0.08,
      rollKd: 1.20, pitchKd: 1.20, yawKd: 0.45,
      rollPID: rPid, pitchPID: pPid, yawPID: yPid,
      leftMotorPWM: leftMotor, rightMotorPWM: rightMotor,
      leftServoPWM: leftServo, rightServoPWM: rightServo,
      pitchServoScale: 100, yawServoScale: 100,
      armed: true
    }

    setConnected(true)
    setStatusMsg('Demo Simulation')
    setFreq(5)
    setTele(data)
    setHistory(prev => {
      const next = [...prev, { ...data, t: (tickRef.current++).toString() }]
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next
    })
  }, [])

  /* ── Polling Real Drone / FastAPI Backend ── */
  const poll = useCallback(async () => {
    if (mode === 'demo') {
      runDemoStep()
      return
    }

    const primaryUrl = getTelemetryUrl(mode)
    let res = null

    try {
      res = await fetch(primaryUrl, { signal: AbortSignal.timeout(1500) })
      if (!res.ok) throw new Error('HTTP ' + res.status)
    } catch {
      if (mode === 'fastapi') {
        const fallbackHost = typeof window !== 'undefined' && window.location.hostname ? window.location.hostname : 'localhost'
        const fallbackProto = typeof window !== 'undefined' && window.location.protocol ? window.location.protocol : 'http:'
        const fallbackPorts = [FASTAPI_URL, `${fallbackProto}//${fallbackHost}:8000`, 'http://localhost:8001']
        for (const baseUrl of fallbackPorts) {
          try {
            const testUrl = `${baseUrl}/telemetry`
            const r = await fetch(testUrl, { signal: AbortSignal.timeout(1000) })
            if (r.ok) {
              res = r
              discoveredFastApiUrlRef.current = baseUrl
              break
            }
          } catch {
            // continue fallback check
          }
        }
      }
    }

    if (!res || !res.ok) {
      failCountRef.current += 1
      if (failCountRef.current >= 3) {
        setConnected(false)
        setStatusMsg(`No Signal (${mode})`)
        setFreq(0)
      }
      return
    }

    // Success! Reset failure count
    failCountRef.current = 0

    try {
      const rawText = await res.text()
      let payload
      try {
        payload = JSON.parse(rawText)
      } catch {
        payload = rawText
      }

      const data = parseEsp32Telemetry(payload)
      const now = Date.now()
      const dt  = now - lastOkRef.current
      lastOkRef.current = now

      const isOnline = mode === 'fastapi' ? (payload._online !== false) : true

      setFreq(dt > 0 ? Math.round(1000 / dt) : 0)
      setConnected(isOnline)
      
      const portNum = discoveredFastApiUrlRef.current.split(':').pop()
      const badgeText = mode === 'fastapi' 
        ? (isOnline ? `FastAPI 🐍 (Port ${portNum})` : `ESP32 Disconnected (FastAPI Port ${portNum})`) 
        : mode === 'direct' ? 'Direct 🌐' : 'Vite Proxy 🔌'
      
      setStatusMsg(isOnline ? `Connected (${badgeText})` : `Searching ESP32... (${badgeText})`)
      setTele(data)
      setHistory(prev => {
        const next = [...prev, { ...data, t: (tickRef.current++).toString() }]
        return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next
      })
    } catch (parseErr) {
      setConnected(false)
      setStatusMsg('Parse Error: ' + parseErr.message)
    }
  }, [mode, getTelemetryUrl, runDemoStep])

  useEffect(() => {
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => clearInterval(id)
  }, [poll])

  const showToast = (type, msg) => setToast({ type, msg })

  return (
    <div className="app">
      {/* ── Topbar ── */}
      <header className="topbar">
        <div className="topbar-brand">
          <div className="brand-icon">🚁</div>
          <div>
            <div className="brand-name">DroneGCS</div>
            <div className="brand-subtitle">Ground Control Station</div>
          </div>
        </div>

        <div className="topbar-status">
          {/* Armed Status Badge */}
          <ArmedBadge armed={tele.armed} />

          {/* Connection Mode Selector */}
          <div style={{ display: 'flex', gap: 4, background: 'rgba(13,20,34,0.9)', padding: 3, borderRadius: 10, border: '1px solid var(--border)' }}>
            {[
              { id: 'fastapi', label: '🐍 FastAPI' },
              { id: 'direct',  label: '🌐 Direct' },
              { id: 'proxy',   label: '🔌 Proxy' },
              { id: 'demo',    label: '🎮 Demo' },
            ].map(m => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                style={{
                  background: mode === m.id ? 'var(--accent-blue)' : 'transparent',
                  color: mode === m.id ? '#070b14' : 'var(--text-secondary)',
                  border: 'none',
                  borderRadius: 7,
                  padding: '4px 10px',
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                  transition: 'var(--transition)',
                }}
              >
                {m.label}
              </button>
            ))}
          </div>

          <span className="freq-badge">{freq} Hz</span>

          <div className={`status-pill ${connected ? 'connected' : 'disconnected'}`}>
            <span className={`status-dot ${connected ? 'pulse' : ''}`} />
            {statusMsg}
          </div>
        </div>
      </header>

      {/* ── Main Grid ── */}
      <main className="main-content">

        {/* 1. Orientation Card */}
        <div className="card orientation-card">
          <div className="card-title">
            <span className="card-title-dot" />
            Drone Orientation
          </div>
          <div className="drone-visual-container">
            <div style={{ display: 'flex', gap: 20, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}>
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8 }}>
                <AttitudeIndicator roll={tele.roll} pitch={tele.pitch} />
                <span style={{ fontSize:'0.65rem', color:'var(--text-muted)', letterSpacing:'0.08em' }}>ATTITUDE</span>
              </div>
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8 }}>
                <DroneTopView yawRate={tele.yawrate} />
                <span style={{ fontSize:'0.65rem', color:'var(--text-muted)', letterSpacing:'0.08em' }}>YAW VIEW</span>
              </div>
            </div>

            {/* IMU readout pills */}
            <div className="imu-values">
              <div className="imu-val-block">
                <div className="imu-val-label">Roll</div>
                <div className="imu-val-num" style={{ color: 'var(--color-roll)' }}>
                  {fmt(tele.roll)}°
                </div>
              </div>
              <div className="imu-val-block">
                <div className="imu-val-label">Pitch</div>
                <div className="imu-val-num" style={{ color: 'var(--color-pitch)' }}>
                  {fmt(tele.pitch)}°
                </div>
              </div>
              <div className="imu-val-block">
                <div className="imu-val-label">Yaw Rate</div>
                <div className="imu-val-num" style={{ color: 'var(--color-yaw)' }}>
                  {fmt(tele.yawrate)}°/s
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 2. Receiver Values Card */}
        <div className="card receiver-card">
          <div className="card-title">
            <span className="card-title-dot" style={{ background:'var(--accent-purple)' }} />
            Receiver (FS-R6B) — Desired
          </div>
          <div className="slider-group">
            <ProgressBar label="Desired Roll"     value={tele.desiredRoll}     range={30}  color="var(--color-roll)"  />
            <ProgressBar label="Desired Pitch"    value={tele.desiredPitch}    range={30}  color="var(--color-pitch)" />
            <ProgressBar label="Desired Yaw Rate" value={tele.desiredYawRate}  range={100} color="var(--color-yaw)"   unit="°/s"/>
          </div>

          <div style={{ marginTop: 20, borderTop:'1px solid var(--border)', paddingTop:16 }}>
            <div className="card-title" style={{ marginBottom:12 }}>
              <span className="card-title-dot" style={{ background:'var(--accent-orange)' }} />
              PID Errors
            </div>
            <div className="pid-error-row">
              {[
                { label:'Roll Error',  val: tele.rollError,  color:'var(--color-roll)'  },
                { label:'Pitch Error', val: tele.pitchError, color:'var(--color-pitch)' },
                { label:'Yaw Error',   val: tele.yawError,   color:'var(--color-yaw)'   },
              ].map(e => (
                <div className="pid-error-item" key={e.label}>
                  <span className="pid-error-label">{e.label}</span>
                  <span className="pid-error-value" style={{ color: e.color }}>
                    {fmt(e.val)}°
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 3. Actuators Card (Motors & Servos PWM) */}
        <div className="card actuators-card">
          <div className="card-title">
            <span className="card-title-dot" style={{ background:'var(--accent-green)' }} />
            Actuator PWM Outputs
          </div>
          <ActuatorPanel
            leftMotor={tele.leftMotorPWM}
            rightMotor={tele.rightMotorPWM}
            leftServo={tele.leftServoPWM}
            rightServo={tele.rightServoPWM}
          />
        </div>

        {/* 4. PID Output & Active Gains Card */}
        <div className="card pid-output-card">
          <div className="card-title">
            <span className="card-title-dot" style={{ background:'var(--accent-yellow)' }} />
            PID Outputs & Active Gains
          </div>
          <div className="pid-output-grid">
            {[
              { label:'Roll PID',  val: tele.rollPID,  color:'var(--color-roll)'  },
              { label:'Pitch PID', val: tele.pitchPID, color:'var(--color-pitch)' },
              { label:'Yaw PID',   val: tele.yawPID,   color:'var(--color-yaw)'   },
            ].map(p => (
              <div className="pid-block" key={p.label}>
                <div className="pid-block-label">{p.label}</div>
                <div className="pid-block-value" style={{ color: p.color }}>
                  {fmt(p.val)}
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginTop:16 }}>
            <div className="card-title" style={{ marginBottom:8 }}>
              <span className="card-title-dot" style={{ background:'var(--accent-cyan)' }} />
              Active PID Gains (Kp, Ki, Kd)
            </div>
            <PidGainsMatrix tele={tele} />
          </div>
        </div>

        {/* 5. Combined PID History Chart */}
        <div className="card chart-card">
          <div className="card-title">
            <span className="card-title-dot" style={{ background:'var(--accent-yellow)' }} />
            PID Output History — Roll / Pitch / Yaw
          </div>
          <div className="chart-legend">
            {[
              { name:'Roll PID',  color:'var(--color-roll)'  },
              { name:'Pitch PID', color:'var(--color-pitch)' },
              { name:'Yaw PID',   color:'var(--color-yaw)'   },
            ].map(l => (
              <div className="legend-item" key={l.name}>
                <div className="legend-swatch" style={{ background: l.color }} />
                {l.name}
              </div>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={history} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="t" hide />
              <YAxis tickCount={7} />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.1)" />
              <Line type="monotoneX" dataKey="rollPID"  stroke="var(--color-roll)"  strokeWidth={2} dot={false} isAnimationActive={false} name="Roll PID"  />
              <Line type="monotoneX" dataKey="pitchPID" stroke="var(--color-pitch)" strokeWidth={2} dot={false} isAnimationActive={false} name="Pitch PID" />
              <Line type="monotoneX" dataKey="yawPID"   stroke="var(--color-yaw)"   strokeWidth={2} dot={false} isAnimationActive={false} name="Yaw PID"   />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* 6. Servo Actuator Scale Card */}
        <div className="card chart-card" style={{ gridColumn: '1 / 4' }}>
          <div className="card-title">
            <span className="card-title-dot" style={{ background:'var(--accent-purple)' }} />
            Servo Scaling Configuration
          </div>
          <ServoScalePanel
            currentPitch={tele.pitchServoScale}
            currentYaw={tele.yawServoScale}
            getServoScaleUrl={getServoScaleUrl}
            onUpdate={showToast}
          />
        </div>

        {/* 7. IMU Time-series row */}
        <div className="imu-charts-row">
          <AxisChart title="IMU — Roll"     dataKey="roll"     data={history} color="var(--color-roll)"  yDomain={[-90,90]}  />
          <AxisChart title="IMU — Pitch"    dataKey="pitch"    data={history} color="var(--color-pitch)" yDomain={[-90,90]}  />
          <AxisChart title="IMU — Yaw Rate" dataKey="yawrate"  data={history} color="var(--color-yaw)"   unit="°/s" yDomain={[-200,200]} />
        </div>

        {/* 8. Full PID Gain Tuning Studio Card */}
        <div className="card kp-card">
          <div className="card-title">
            <span className="card-title-dot" style={{ background:'var(--accent-cyan)' }} />
            PID Gain Tuning Studio — Update Gains (Kp, Ki, Kd)
          </div>
          <PidTuningStudio
            tele={tele}
            getKpUrl={getKpUrl}
            getKiUrl={getKiUrl}
            getKdUrl={getKdUrl}
            onUpdate={showToast}
          />
        </div>

      </main>

      {/* Toast */}
      {toast && (
        <Toast
          msg={toast.msg}
          type={toast.type}
          onDone={() => setToast(null)}
        />
      )}
    </div>
  )
}

