export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      forecast_configs: {
        Row: {
          dead_stock_days: number | null
          forecast_window_days: number | null
          low_stock_threshold: number | null
          reorder_lead_days: number | null
          safety_stock_days: number | null
          shop_id: string
        }
        Insert: {
          dead_stock_days?: number | null
          forecast_window_days?: number | null
          low_stock_threshold?: number | null
          reorder_lead_days?: number | null
          safety_stock_days?: number | null
          shop_id: string
        }
        Update: {
          dead_stock_days?: number | null
          forecast_window_days?: number | null
          low_stock_threshold?: number | null
          reorder_lead_days?: number | null
          safety_stock_days?: number | null
          shop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "forecast_configs_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: true
            referencedRelation: "shops"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      gdpr_requests: {
        Row: {
          customer_id: number | null
          id: string
          processed_at: string | null
          shop_id: string
          type: string
        }
        Insert: {
          customer_id?: number | null
          id?: string
          processed_at?: string | null
          shop_id: string
          type: string
        }
        Update: {
          customer_id?: number | null
          id?: string
          processed_at?: string | null
          shop_id?: string
          type?: string
        }
        Relationships: []
      }
      inventory_levels: {
        Row: {
          id: string
          location_name: string | null
          quantity: number
          shop_id: string
          shopify_location_id: number
          sku_id: string
          updated_at: string | null
        }
        Insert: {
          id?: string
          location_name?: string | null
          quantity?: number
          shop_id: string
          shopify_location_id: number
          sku_id: string
          updated_at?: string | null
        }
        Update: {
          id?: string
          location_name?: string | null
          quantity?: number
          shop_id?: string
          shopify_location_id?: number
          sku_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_levels_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "sku_analytics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_levels_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      processed_webhooks: {
        Row: {
          external_id: string
          id: string
          processed_at: string
          shop_id: string
          source: string
        }
        Insert: {
          external_id: string
          id?: string
          processed_at?: string
          shop_id: string
          source: string
        }
        Update: {
          external_id?: string
          id?: string
          processed_at?: string
          shop_id?: string
          source?: string
        }
        Relationships: []
      }
      sales_history: {
        Row: {
          id: string
          quantity_sold: number
          shop_id: string
          shopify_line_item_id: number | null
          shopify_order_id: number | null
          sku_id: string
          sold_at: string
        }
        Insert: {
          id?: string
          quantity_sold: number
          shop_id: string
          shopify_line_item_id?: number | null
          shopify_order_id?: number | null
          sku_id: string
          sold_at: string
        }
        Update: {
          id?: string
          quantity_sold?: number
          shop_id?: string
          shopify_line_item_id?: number | null
          shopify_order_id?: number | null
          sku_id?: string
          sold_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sales_history_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "sku_analytics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_history_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      shopify_sessions: {
        Row: {
          access_token: string | null
          created_at: string | null
          expires: string | null
          id: string
          is_online: boolean | null
          scope: string | null
          shop: string
          state: string
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          access_token?: string | null
          created_at?: string | null
          expires?: string | null
          id: string
          is_online?: boolean | null
          scope?: string | null
          shop: string
          state: string
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          access_token?: string | null
          created_at?: string | null
          expires?: string | null
          id?: string
          is_online?: boolean | null
          scope?: string | null
          shop?: string
          state?: string
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      shops: {
        Row: {
          bsale_last_sync: string | null
          bsale_token: string | null
          id: string
          installed_at: string | null
          is_active: boolean | null
          plan: string | null
          settings: Json | null
          shop_id: string
          sku_limit: number | null
          uninstalled_at: string | null
        }
        Insert: {
          bsale_last_sync?: string | null
          bsale_token?: string | null
          id?: string
          installed_at?: string | null
          is_active?: boolean | null
          plan?: string | null
          settings?: Json | null
          shop_id: string
          sku_limit?: number | null
          uninstalled_at?: string | null
        }
        Update: {
          bsale_last_sync?: string | null
          bsale_token?: string | null
          id?: string
          installed_at?: string | null
          is_active?: boolean | null
          plan?: string | null
          settings?: Json | null
          shop_id?: string
          sku_limit?: number | null
          uninstalled_at?: string | null
        }
        Relationships: []
      }
      skus: {
        Row: {
          barcode: string | null
          barcode_type: string | null
          bsale_variant_id: string | null
          cost_price: number | null
          created_at: string | null
          id: string
          product_type: string | null
          shop_id: string
          shopify_product_id: number | null
          shopify_variant_id: number | null
          sku_code: string
          status: string | null
          tags: string[] | null
          title: string | null
          updated_at: string | null
          vendor: string | null
        }
        Insert: {
          barcode?: string | null
          barcode_type?: string | null
          bsale_variant_id?: string | null
          cost_price?: number | null
          created_at?: string | null
          id?: string
          product_type?: string | null
          shop_id: string
          shopify_product_id?: number | null
          shopify_variant_id?: number | null
          sku_code: string
          status?: string | null
          tags?: string[] | null
          title?: string | null
          updated_at?: string | null
          vendor?: string | null
        }
        Update: {
          barcode?: string | null
          barcode_type?: string | null
          bsale_variant_id?: string | null
          cost_price?: number | null
          created_at?: string | null
          id?: string
          product_type?: string | null
          shop_id?: string
          shopify_product_id?: number | null
          shopify_variant_id?: number | null
          sku_code?: string
          status?: string | null
          tags?: string[] | null
          title?: string | null
          updated_at?: string | null
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "skus_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      sync_jobs: {
        Row: {
          completed_at: string | null
          error_message: string | null
          id: string
          operation_id: string | null
          records_processed: number | null
          shop_id: string
          started_at: string | null
          status: string | null
          type: string
        }
        Insert: {
          completed_at?: string | null
          error_message?: string | null
          id?: string
          operation_id?: string | null
          records_processed?: number | null
          shop_id: string
          started_at?: string | null
          status?: string | null
          type: string
        }
        Update: {
          completed_at?: string | null
          error_message?: string | null
          id?: string
          operation_id?: string | null
          records_processed?: number | null
          shop_id?: string
          started_at?: string | null
          status?: string | null
          type?: string
        }
        Relationships: []
      }
      woo_connections: {
        Row: {
          id: string
          shop_id: string
          url: string
          consumer_key: string
          consumer_secret: string
          product_count: number | null
          order_count: number | null
          analyzed_at: string | null
          migrated_at: string | null
        }
        Insert: {
          id?: string
          shop_id: string
          url: string
          consumer_key: string
          consumer_secret: string
          product_count?: number | null
          order_count?: number | null
          analyzed_at?: string | null
          migrated_at?: string | null
        }
        Update: {
          id?: string
          shop_id?: string
          url?: string
          consumer_key?: string
          consumer_secret?: string
          product_count?: number | null
          order_count?: number | null
          analyzed_at?: string | null
          migrated_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      sku_analytics: {
        Row: {
          cost_price: number | null
          id: string | null
          last_sold_at: string | null
          shop_id: string | null
          sku_code: string | null
          sold_30d: number | null
          sold_90d: number | null
          status: string | null
          title: string | null
          total_stock: number | null
          vendor: string | null
        }
        Relationships: [
          {
            foreignKeyName: "skus_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["shop_id"]
          },
        ]
      }
    }
    Functions: {
      refresh_sku_analytics: { Args: never; Returns: undefined }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

