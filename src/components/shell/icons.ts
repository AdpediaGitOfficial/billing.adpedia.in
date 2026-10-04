/**
 * The icon registry — docs/68 §2.
 *
 * 🔴 This file exists so that `lucide-react` is tree-shaken. The obvious implementation of a
 * name-addressed icon is `import * as Icons from 'lucide-react'` and a lookup, and it is what
 * was here for sixty-seven modules: it shipped **all 1,544 icons** — `Tractor`,
 * `GitPullRequestDraft`, `AudioWaveform` — in a 518 kB chunk loaded by the app layout, so by
 * every route. A bundler cannot prove which member of a namespace a runtime string will reach,
 * so it keeps them all. Only a static named import can be dropped.
 *
 * Adding an icon means adding it here, in both places. `IconName` is derived from this object,
 * so a name that is not in it is a typecheck error rather than a silently rendered circle.
 */
import {
  AlertOctagon, AlertTriangle, ArrowDownLeft, ArrowLeft, ArrowRight, ArrowUpRight,
  Banknote, Bell, BellRing, BookOpen, Building2,
  Calendar, CalendarClock, CalendarX, Camera, ChartPie, Check, CheckCircle2, ChevronDown,
  ChevronLeft, ChevronRight, Circle, Clock, Construction, CreditCard,
  Download, FileCheck, FileInput, FileStack, FileText, FileWarning, FolderKanban,
  HandCoins, Hash, Home, IdCard, Import, Inbox, Info,
  Landmark, LayoutDashboard, LayoutGrid, LineChart, ListChecks, ListTree, Lock, LogOut,
  Mail, Menu, MessageCircle, MessageSquare, Milestone,
  Package, PanelLeftClose, PanelLeftOpen, Pencil, Percent, Phone, Plus,
  QrCode, Receipt, RefreshCw, Ruler, Scale, ScrollText, Search, Send, ShieldCheck,
  ShieldQuestion, Smartphone, Sparkles, Store,
  TrendingDown, TrendingUp, Undo2, Upload, UserCog, UserX, Users, Wallet,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export const ICONS = {
  AlertOctagon, AlertTriangle, ArrowDownLeft, ArrowLeft, ArrowRight, ArrowUpRight,
  Banknote, Bell, BellRing, BookOpen, Building2,
  Calendar, CalendarClock, CalendarX, Camera, ChartPie, Check, CheckCircle2, ChevronDown,
  ChevronLeft, ChevronRight, Circle, Clock, Construction, CreditCard,
  Download, FileCheck, FileInput, FileStack, FileText, FileWarning, FolderKanban,
  HandCoins, Hash, Home, IdCard, Import, Inbox, Info,
  Landmark, LayoutDashboard, LayoutGrid, LineChart, ListChecks, ListTree, Lock, LogOut,
  Mail, Menu, MessageCircle, MessageSquare, Milestone,
  Package, PanelLeftClose, PanelLeftOpen, Pencil, Percent, Phone, Plus,
  QrCode, Receipt, RefreshCw, Ruler, Scale, ScrollText, Search, Send, ShieldCheck,
  ShieldQuestion, Smartphone, Sparkles, Store,
  TrendingDown, TrendingUp, Undo2, Upload, UserCog, UserX, Users, Wallet,
} satisfies Record<string, LucideIcon>

export type IconName = keyof typeof ICONS
