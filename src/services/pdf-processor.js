export async function uploadAndConvertPdf(env, file, userId, inputId) {
  const r2Key = `uploads/${userId}/${inputId}/${file.name}`;

  // Store PDF in R2
  const arrayBuffer = await file.arrayBuffer();
  await env.R2.put(r2Key, arrayBuffer, {
    httpMetadata: { contentType: 'application/pdf' }
  });

  // Convert to markdown using Workers AI
  let markdownText = '';
  try {
    const result = await env.AI.toMarkdown([{
      name: file.name,
      blob: new Blob([arrayBuffer], { type: 'application/pdf' })
    }]);
    markdownText = result[0]?.data || '';
  } catch (err) {
    return { r2Key, markdownText: '', error: `PDF conversion failed: ${err.message || 'unknown error'}` };
  }

  if (!markdownText.trim()) {
    return { r2Key, markdownText: '', error: 'PDF conversion returned empty text. The PDF may contain only images or scanned content.' };
  }

  return { r2Key, markdownText };
}
