'use client'
import { useEffect, useState } from 'react'
import { Card, Button } from '@/components/ui/kit'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    setInstalled(window.matchMedia('(display-mode: standalone)').matches)
    const onPrompt = (e: Event) => { e.preventDefault(); setDeferred(e as BeforeInstallPromptEvent) }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', () => setInstalled(true))
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])

  if (installed) return null

  return (
    <Card className="p-4">
      <p className="text-[14px] font-semibold">Add to home screen</p>
      <p className="mt-1 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
        {deferred
          ? 'Opens full screen, and expense capture works without a connection.'
          : 'On iPhone: Share → Add to Home Screen. On Android: the browser menu → Install app.'}
      </p>
      {deferred && (
        <Button className="mt-3" onClick={() => { void deferred.prompt(); setDeferred(null) }}>
          Install
        </Button>
      )}
    </Card>
  )
}
