import * as React from "react"

import { cn } from "@/lib/utils"

// The shell only. shadcn's card ships a header, title, description, action,
// content and footer alongside it; this theme lays out its cards itself, so all
// six were unused from the moment they were vendored. Restore one from upstream
// if a card ever needs it.
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        // 卡片这个「壳」照参考站那套：`rounded-lg border bg-card`，**不带阴影**——
        // 它靠「浅灰页面 + 白卡 + 一道描边」把卡片托出来，加阴影反而糊成一团。
        "flex flex-col gap-6 rounded-lg border bg-card py-6 text-card-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Card }
