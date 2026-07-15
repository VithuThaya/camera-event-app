import Link from "next/link"

import { buttonStyles } from "@/components/ui/Button"
import { Eyebrow } from "@/components/ui/Panel"

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-12">
      <Eyebrow>A shared camera for your event</Eyebrow>
      {/* text-balance so the three sentences break where they mean to rather
          than wherever the viewport runs out. This line is the product. */}
      <h1 className="mt-3 text-4xl font-semibold leading-[1.15] text-balance">
        Everyone shoots. Nobody peeks. You reveal.
      </h1>
      <p className="mt-4 text-pretty text-ink-dim">
        Share one QR code. Guests get a handful of shots each — no app, no
        signup. Nothing is visible until you unlock it.
      </p>

      {/* buttonStyles rather than <Button>: next/link renders its own anchor,
          and a link dressed as a button must not become a second definition. */}
      <Link href="/create" className={`${buttonStyles()} mt-8 w-full`}>
        Create an event
      </Link>
    </main>
  )
}
