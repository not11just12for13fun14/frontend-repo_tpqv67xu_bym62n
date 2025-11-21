import React, { useEffect, useRef, useState } from 'react'

// Utility to format filename
function formatFilename({ siteName, date, seq, lat, lng }) {
  const safeSite = siteName.replace(/[^a-zA-Z0-9_-]/g, '_')
  const d = date
  return `${safeSite}_${d}_${String(seq).padStart(3, '0')}_${lat.toFixed(6)}_${lng.toFixed(6)}.jpg`
}

export default function MobileCapture() {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const [siteName, setSiteName] = useState('')
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [coords, setCoords] = useState(null)
  const [headingRef, setHeadingRef] = useState(null)
  const [pitchRef, setPitchRef] = useState(null)
  const [zoom, setZoom] = useState(1)
  const [mode, setMode] = useState('1x')
  const [seq, setSeq] = useState(0)
  const [started, setStarted] = useState(false)
  const [startCoords, setStartCoords] = useState(null)
  const [distance, setDistance] = useState(0)
  const [batteryLow, setBatteryLow] = useState(false)
  const [storageOk, setStorageOk] = useState(true)
  const [angleBaseline, setAngleBaseline] = useState(null)
  const [angleWarning, setAngleWarning] = useState(false)
  const [capturing, setCapturing] = useState(false)

  const backend = import.meta.env.VITE_BACKEND_URL || ''

  // Haversine distance meters
  function distanceMeters(a, b) {
    if (!a || !b) return 0
    const toRad = (x) => (x * Math.PI) / 180
    const R = 6371000
    const dLat = toRad(b.latitude - a.latitude)
    const dLon = toRad(b.longitude - a.longitude)
    const lat1 = toRad(a.latitude)
    const lat2 = toRad(b.latitude)
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(h))
  }

  // Permissions and sensors
  useEffect(() => {
    const geoWatch = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords
        setCoords({ latitude, longitude })
        if (!startCoords) setStartCoords({ latitude, longitude })
        if (startCoords) setDistance(distanceMeters(startCoords, { latitude, longitude }))
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 1000 }
    )

    // Battery
    if (navigator.getBattery) {
      navigator.getBattery().then((b) => {
        const check = () => setBatteryLow(b.level <= 0.15)
        check()
        b.addEventListener('levelchange', check)
      })
    }

    // Storage check: try quota
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(({ quota, usage }) => {
        if (quota && usage) {
          const free = quota - usage
          setStorageOk(free > 100 * 1024 * 1024) // need >100MB free
        }
      })
    }

    // Device orientation
    const handleOrient = (e) => {
      const pitch = e.beta // front-back tilt
      const heading = e.alpha // compass heading (approx)
      setHeadingRef(heading)
      setPitchRef(pitch)
      if (angleBaseline == null && started) setAngleBaseline(pitch)
      if (angleBaseline != null) {
        const diff = Math.abs(pitch - angleBaseline)
        setAngleWarning(diff > 5)
      }
    }
    window.addEventListener('deviceorientation', handleOrient)

    return () => {
      navigator.geolocation.clearWatch(geoWatch)
      window.removeEventListener('deviceorientation', handleOrient)
    }
  }, [started, angleBaseline, startCoords])

  async function startCamera() {
    try {
      const constraints = {
        video: {
          facingMode: 'environment',
          zoom: true,
        },
        audio: false,
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      videoRef.current.srcObject = stream
      await videoRef.current.play()
      const track = stream.getVideoTracks()[0]
      const cap = track.getCapabilities()
      if (cap.zoom) {
        const desired = mode === '0.5x' ? cap.zoom.min : 1
        const settings = track.getSettings()
        const to = Math.min(cap.zoom.max, Math.max(cap.zoom.min, desired))
        await track.applyConstraints({ advanced: [{ zoom: to }] })
        setZoom(to)
      }
    } catch (e) {
      alert('Kamera açılamadı: ' + e.message)
    }
  }

  async function createSession() {
    if (!siteName || !coords) {
      alert('Alan adı ve konum gerekli')
      return
    }
    const res = await fetch(`${backend}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site_name: siteName,
        date,
        start_lat: coords.latitude,
        start_lng: coords.longitude,
        device: navigator.userAgent,
        battery_level: window?.navigator?.getBattery ? undefined : undefined,
      }),
    })
    const data = await res.json()
    return data.session_id
  }

  async function captureAndUpload(sessionId) {
    if (!videoRef.current) return
    const canvas = canvasRef.current
    const video = videoRef.current
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')

    // draw with overlay crosshair (not in final file)
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))

    const current = coords
    const filename = formatFilename({ siteName, date, seq: seq + 1, lat: current.latitude, lng: current.longitude })

    const form = new FormData()
    form.append('session_id', sessionId)
    form.append('seq', String(seq + 1))
    form.append('lat', String(current.latitude))
    form.append('lng', String(current.longitude))
    if (pitchRef != null) form.append('tilt_deg', String(pitchRef))
    if (headingRef != null) form.append('heading_deg', String(headingRef))
    form.append('zoom', String(zoom))
    form.append('filename', filename)
    form.append('file', new File([blob], filename, { type: 'image/jpeg' }))

    await fetch(`${backend}/api/photos`, { method: 'POST', body: form })
    setSeq((s) => s + 1)
  }

  async function onStart() {
    if (!storageOk) {
      alert('Cihazda yeterli depolama alanı yok')
      return
    }
    if (batteryLow) {
      if (!confirm('Batarya düşük. Yine de devam edilsin mi?')) return
    }
    await startCamera()
    const sid = await createSession()
    if (!sid) return
    setStarted(true)
    setCapturing(true)
  }

  function onStop() {
    const stream = videoRef.current?.srcObject
    if (stream) {
      stream.getTracks().forEach((t) => t.stop())
    }
    setCapturing(false)
    setStarted(false)
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4">
      <h1 className="text-2xl font-bold mb-4">TrenchSight - Mobil Çekim</h1>
      <div className="space-y-3">
        <input className="w-full p-2 rounded bg-slate-800" placeholder="Kazı alanı adı" value={siteName} onChange={(e) => setSiteName(e.target.value)} />
        <input className="w-full p-2 rounded bg-slate-800" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <div className="flex items-center justify-between">
          <div>Konum: {coords ? `${coords.latitude.toFixed(6)}, ${coords.longitude.toFixed(6)}` : 'Alınıyor...'}</div>
          <div>İlerleme: {distance.toFixed(1)} m</div>
        </div>
        <div className="flex items-center gap-3">
          <button className={`px-3 py-1 rounded ${mode==='0.5x'?'bg-blue-600':'bg-slate-800'}`} onClick={() => setMode('0.5x')}>0.5x</button>
          <button className={`px-3 py-1 rounded ${mode==='1x'?'bg-blue-600':'bg-slate-800'}`} onClick={() => setMode('1x')}>1x</button>
          <div>Açı uyarısı: {angleWarning ? '⚠️' : '✅'} {pitchRef!=null ? `${pitchRef.toFixed(1)}°` : ''}</div>
          <div>Foto sayısı: {seq}</div>
        </div>
      </div>

      <div className="relative mt-4">
        <video ref={videoRef} className="w-full rounded bg-black" playsInline muted></video>
        {/* center crosshair dashed */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="w-40 h-40 border-2 border-dashed border-white/70 rounded"></div>
        </div>
        <canvas ref={canvasRef} className="hidden" />
      </div>

      <div className="mt-4 flex gap-3">
        {!capturing ? (
          <button className="flex-1 bg-green-600 rounded py-3" onClick={onStart}>Çekimi Başlat</button>
        ) : (
          <>
            <button className="flex-1 bg-blue-600 rounded py-3" disabled={angleWarning} onClick={async ()=>{await captureAndUpload(await createSession())}}>Foto Çek</button>
            <button className="flex-1 bg-red-600 rounded py-3" onClick={onStop}>Bitir</button>
          </>
        )}
      </div>

      <div className="mt-2 text-sm text-slate-300">
        Batarya: {batteryLow ? 'Düşük' : 'İyi'} • Depolama: {storageOk ? 'Yeterli' : 'Yetersiz'}
      </div>
    </div>
  )
}
