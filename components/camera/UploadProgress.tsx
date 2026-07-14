"use client"

/**
 * Upload progress.
 *
 * Shown from the moment the bytes start moving. A 40 MB clip on party wifi can
 * take a while, and an unexplained pause is what makes someone close the tab
 * halfway through — losing the shot for good, since nothing is kept until
 * confirm succeeds.
 */
export function UploadProgress({ fraction }: { fraction: number }) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100)
  // The tail end is our server downloading, stripping and re-uploading the
  // photo, which reports nothing. Saying "Finishing" is honest about the wait;
  // a bar parked at 100% while nothing visibly happens is not.
  const label = percent >= 100 ? "Finishing…" : `Uploading… ${percent}%`

  return (
    <div className="w-full">
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-neutral-800"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Upload progress"
      >
        <div
          className="h-full bg-white transition-[width] duration-200 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-2 text-center text-xs text-neutral-400">{label}</p>
    </div>
  )
}
