import Link from "next/link"

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-12">
      <p className="text-xs uppercase tracking-widest text-neutral-500">
        A shared camera for your event
      </p>
      <h1 className="mt-3 text-4xl font-semibold leading-tight">
        Everyone shoots. Nobody peeks. You reveal.
      </h1>
      <p className="mt-4 text-neutral-400">
        Share one QR code. Guests get a handful of shots each — no app, no
        signup. Nothing is visible until you unlock it.
      </p>

      <Link
        href="/create"
        className="mt-8 rounded bg-white px-4 py-3 text-center font-medium text-black"
      >
        Create an event
      </Link>
    </main>
  )
}
