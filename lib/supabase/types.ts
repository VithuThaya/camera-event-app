// Generated from the live schema via the Supabase MCP connector.
// Regenerate after every migration; do not hand-edit.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      events: {
        Row: {
          created_at: string
          deleted_at: string | null
          guest_token: string
          host_token: string
          id: string
          is_unlocked: boolean
          max_guests: number
          max_storage_bytes: number
          max_uploads_per_guest: number
          name: string
          plan_tier: string
          retention_days: number
          status: string
          storage_used_bytes: number
          unlock_at: string | null
          unlocked_at: string | null
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          guest_token: string
          host_token: string
          id?: string
          is_unlocked?: boolean
          max_guests?: number
          max_storage_bytes?: number
          max_uploads_per_guest?: number
          name: string
          plan_tier?: string
          retention_days?: number
          status?: string
          storage_used_bytes?: number
          unlock_at?: string | null
          unlocked_at?: string | null
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          guest_token?: string
          host_token?: string
          id?: string
          is_unlocked?: boolean
          max_guests?: number
          max_storage_bytes?: number
          max_uploads_per_guest?: number
          name?: string
          plan_tier?: string
          retention_days?: number
          status?: string
          storage_used_bytes?: number
          unlock_at?: string | null
          unlocked_at?: string | null
        }
        Relationships: []
      }
      guest_sessions: {
        Row: {
          consent_ack_at: string | null
          created_at: string
          event_id: string
          id: string
          last_seen_at: string
          upload_count: number
        }
        Insert: {
          consent_ack_at?: string | null
          created_at?: string
          event_id: string
          id?: string
          last_seen_at?: string
          upload_count?: number
        }
        Update: {
          consent_ack_at?: string | null
          created_at?: string
          event_id?: string
          id?: string
          last_seen_at?: string
          upload_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "guest_sessions_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      media_items: {
        Row: {
          created_at: string
          deleted_at: string | null
          duration_seconds: number | null
          event_id: string
          exif_stripped: boolean
          guest_session_id: string
          id: string
          media_type: string
          mime_type: string
          size_bytes: number
          status: string
          storage_path: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          duration_seconds?: number | null
          event_id: string
          exif_stripped?: boolean
          guest_session_id: string
          id?: string
          media_type: string
          mime_type: string
          size_bytes: number
          status?: string
          storage_path: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          duration_seconds?: number | null
          event_id?: string
          exif_stripped?: boolean
          guest_session_id?: string
          id?: string
          media_type?: string
          mime_type?: string
          size_bytes?: number
          status?: string
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "media_items_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "media_items_guest_session_id_fkey"
            columns: ["guest_session_id"]
            isOneToOne: false
            referencedRelation: "guest_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DefaultSchema = Database["public"]

export type Tables<T extends keyof DefaultSchema["Tables"]> =
  DefaultSchema["Tables"][T]["Row"]
export type TablesInsert<T extends keyof DefaultSchema["Tables"]> =
  DefaultSchema["Tables"][T]["Insert"]
export type TablesUpdate<T extends keyof DefaultSchema["Tables"]> =
  DefaultSchema["Tables"][T]["Update"]

export type EventRow = Tables<"events">
export type GuestSessionRow = Tables<"guest_sessions">
export type MediaItemRow = Tables<"media_items">
