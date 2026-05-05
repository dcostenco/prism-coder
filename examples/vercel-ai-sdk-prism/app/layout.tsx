export const metadata = {
  title: 'Prism MCP × Vercel AI SDK',
  description: 'Reference example: Vercel AI SDK chat with Prism MCP as the memory backend.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
