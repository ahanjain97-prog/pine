// Fictional findings only. Safe for screenshots in this public repository.
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
function samplePdf() {
  const stream = 'BT /F1 20 Tf 60 730 Td (PINE - fictional demonstration report) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(pdf);
}
export function demoPublication() {
  const titles = [
    ['cpl-scouting', 'Scouting the Canadian Premier League', 'Scouting & recruitment', 'Preliminary', ['CPL', 'Recruiting markets', 'Transfer outcomes']],
    ['recruiting-playbook', 'USL1 recruiting playbook 2027', 'Scouting & recruitment', 'Analysis', ['Recruiting channels', 'Roster building', '2027 planning']],
    ['mlsnp-graduation', 'Which MLS NEXT Pro players translate to USL?', 'Scouting & recruitment', 'Analysis', ['MLS NEXT Pro', 'Screening rules', 'Transfer outcomes']],
    ['what-wins-usl', 'What makes USL teams successful?', 'Team performance', 'Analysis', ['Team building', 'Chance creation', 'Box protection']],
    ['long-throws', 'Long throws: threat, repeatability, and pitch fit', 'Team performance', 'Analysis', ['Set pieces', 'Long throws', 'Pitch geometry']],
    ['age-curves', 'Age curves: evaluating veteran trajectories', 'Player development', 'Reference', ['Age & development', 'Veterans', 'Projection limits']],
  ];
  return { schema_version: 1, generated_at: new Date().toISOString(), reports: titles.map(([slug, title, topic, status, tags], i) => {
    const text = `# ${title}\n\nFictional demonstration source for interface review. No club analysis or private findings.\n`;
    return { slug, title, topic, status, tags,
      summary: [
        'Demonstration: a market overview organized around historical opportunity, position groups, and the questions to check before scouting.',
        'Demonstration: a guide to comparing recruiting channels, with role capture and performance kept separate.',
        'Demonstration: an introduction to screening a development league, with sample warnings and a clear route to the evidence.',
        'Demonstration: a staff brief connecting team-building questions to repeatable processes and the full study.',
        'Demonstration: a guide to reading throw-in rankings, opportunity, and pitch geometry alongside the sample.',
        'Demonstration: a methodological reference for reading player trajectories with uncertainty kept visible.',
      ][i], updated: ['2026-09-27', '2026-09-04', '2026-10-20', '2026-10-03', '2026-09-06', '2026-07-08'][i],
      reviewed: '2026-11-09', review_after: '2027-01-15', read_minutes: 4,
      coverage: 'Fictional demonstration cohort, 2025-2026. No real player or club findings are shown.',
      takeaways: ['This is demonstration content for reviewing the interface.', 'Use a short staff brief to understand the question, then open the original analysis for the evidence.', 'Coverage, uncertainty and review dates stay visible alongside every conclusion.'],
      limitations: 'All findings and table values here are fictional. This sample illustrates how staff will read study limitations; it is not scouting guidance.',
      sections: [
        { title: 'What the evidence covers', paragraphs: ['A consistent report structure helps staff understand the question before reading the detail. Every publication records the exact source revision and the period its evidence covers.', 'This fictional example shows the reading experience without publishing private research in a public pull request.'] },
        { title: 'How to read the comparison', paragraphs: ['Read the size of each group alongside its observed outcome. Treat small samples as a prompt for further review.'], table: { columns: ['Example group', 'Observations', 'Interpretation'], rows: [['Harbor cohort', '24', 'Illustrative sample'], ['Valley cohort', '12', 'Smaller sample'], ['Summit cohort', '8', 'Limited evidence']] } },
        { title: 'Using the report', paragraphs: ['Use the brief to orient a staff discussion. Follow the full source when you need definitions, detailed comparisons, or the reasoning behind a limitation.'] },
      ],
      source: { repository: 'fordb/hearts-of-pine', ref: 'a'.repeat(40), path: 'reports/demo.md', text, sha256: sha(text) },
      documents: [{ id: 'sample', label: 'Open sample PDF', format: 'pdf', data: samplePdf().toString('base64'), sha256: sha(samplePdf()) }],
    };
  }) };
}
