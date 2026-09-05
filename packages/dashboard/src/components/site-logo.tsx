import { useEffect, useState } from 'react';
import { SITE_TITLE, SITE_TAGLINE } from '../site-config';

/** Up-trend chart glyph used inside the gradient brand square. */
const MARK_GLYPH = (
  <svg width="52%" height="52%" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M3 16 L9 9 L13 13.5 L21 4.5" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="21" cy="4.5" r="2.3" fill="var(--accent)" />
  </svg>
);

// ── Logo detection (cached per session) ──

let cachedHasLogo: boolean | null = null;

function probeImage(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

function useHasLogo(): boolean | null {
  const [has, setHas] = useState<boolean | null>(cachedHasLogo);
  useEffect(() => {
    if (cachedHasLogo !== null) return;
    probeImage('/logo.png').then((ok) => {
      cachedHasLogo = ok;
      setHas(ok);
    });
  }, []);
  return has;
}

// ── Dynamic favicon from logo.png (preserve original shape) ──

let faviconApplied = false;

export function useFaviconFromLogo() {
  const hasLogo = useHasLogo();

  useEffect(() => {
    if (faviconApplied || !hasLogo) return;
    faviconApplied = true;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const size = 64;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d')!;

      // Draw image without circular clipping so branded square/rounded-square logos keep their shape.
      const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);

      const dataUrl = canvas.toDataURL('image/png');

      // Replace existing favicon link
      let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.type = 'image/png';
      link.href = dataUrl;
    };
    img.src = '/logo.png';
  }, [hasLogo]);
}

// ── Brand mark: gradient rounded square with chart glyph (or custom logo.png) ──

function BrandMark({ size, radius }: { size: number; radius: number }) {
  const hasLogo = useHasLogo();
  if (hasLogo) {
    return (
      <img
        src="/logo.png"
        alt="Logo"
        className="shrink-0 object-contain"
        style={{ width: size, height: size, borderRadius: radius }}
      />
    );
  }
  return (
    <div
      className="flex shrink-0 items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: 'var(--accent-soft)',
        border: '1px solid var(--border)',
      }}
      aria-hidden="true"
    >
      {MARK_GLYPH}
    </div>
  );
}

// ── Public components ──

/** Full header brand lockup: square mark + wordmark + tagline. */
export function HeaderLogo() {
  return (
    <span className="flex items-center gap-3">
      <BrandMark size={40} radius={12} />
      <span className="flex flex-col leading-none">
        <span className="font-display text-[20px] sm:text-[22px] font-bold tracking-tight" style={{ color: 'var(--fg)' }}>
          {SITE_TITLE}
        </span>
        <span
          className="font-mono mt-[3px] text-[10px] uppercase"
          style={{ letterSpacing: '0.22em', color: 'var(--accent)' }}
        >
          {SITE_TAGLINE}
        </span>
      </span>
    </span>
  );
}

/** Footer logo (small square mark). */
export function FooterLogo() {
  return <BrandMark size={22} radius={7} />;
}
