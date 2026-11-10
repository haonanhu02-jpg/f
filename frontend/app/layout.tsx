import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "万盛 · 档案台账管理系统",
  description: "公司档案统一登记与查询，按公司、分类管理档案资料。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
