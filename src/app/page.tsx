import { redirect } from 'next/navigation'
import { getContext } from '@/server/context'

export default async function Root() {
  redirect((await getContext()) ? '/dashboard' : '/login')
}
