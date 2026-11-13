import { describe, expect, it } from 'vitest'
import { checkMapping, csvCandidates, parseCsv, parseVcards } from './import'

/**
 * Reading contacts from files (pure, runs in the browser). vCard is a
 * structured format: its properties say what each value is. A CSV's columns
 * mean what the person says they mean — the mapping is theirs, never guessed
 * from header names.
 */

describe('parseVcards', () => {
  it('reads name, organisation, title, emails, phones, links, notes and categories (vCard 3.0, folded lines, escapes)', () => {
    const text = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:Voss;Mara;;;',
      'FN:Mara Voss',
      'ORG:Northwind Ventures;Seed',
      'TITLE:Partner',
      'EMAIL;TYPE=INTERNET,WORK:mara@northwind.example',
      'EMAIL;TYPE=HOME:mara@home.example',
      'TEL;TYPE=CELL:+49 30 1234',
      'URL:https://northwind.example',
      'X-SOCIALPROFILE;TYPE=linkedin:https://www.linkedin.com/in/mara',
      'NOTE:Met at the Berlin breakfast\\, wants the deck.\\nInvests in seed rounds',
      '  and pre-seed.',
      'CATEGORIES:Investor,Berlin',
      'PHOTO;ENCODING=b;TYPE=JPEG:AAAA',
      'END:VCARD',
    ].join('\r\n')
    expect(parseVcards(text)).toEqual([
      {
        name: 'Mara Voss',
        organisation: 'Northwind Ventures, Seed',
        title: 'Partner',
        channels: [
          { type: 'email', value: 'mara@northwind.example' },
          { type: 'email', value: 'mara@home.example' },
          { type: 'phone', value: '+49 30 1234' },
          { type: 'website', value: 'https://northwind.example' },
          { type: 'linkedin', value: 'https://www.linkedin.com/in/mara' },
        ],
        metHow: null,
        whyRelevant: 'Met at the Berlin breakfast, wants the deck.\nInvests in seed rounds and pre-seed.',
        tags: ['Investor', 'Berlin'],
      },
    ])
  })

  it('reads several cards; without FN the name comes from N; vCard 4.0 tel: URIs; grouped properties', () => {
    const text = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'N:Park;Jon;;Dr.;',
      'item1.EMAIL:jon@atelier.example',
      'TEL;VALUE=uri;TYPE=work:tel:+49-40-555',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Zoë Ł',
      'END:VCARD',
    ].join('\n')
    expect(parseVcards(text).map((c) => [c.name, c.channels])).toEqual([
      [
        'Dr. Jon Park',
        [
          { type: 'email', value: 'jon@atelier.example' },
          { type: 'phone', value: '+49-40-555' },
        ],
      ],
      ['Zoë Ł', []],
    ])
  })

  it('decodes vCard 2.1 quoted-printable UTF-8 (soft line breaks included)', () => {
    const text = [
      'BEGIN:VCARD',
      'VERSION:2.1',
      'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:J=C3=BCrgen M=C3=BC=',
      'ller',
      'END:VCARD',
    ].join('\r\n')
    expect(parseVcards(text)[0]!.name).toBe('Jürgen Müller')
  })

  it('a card with no name keeps an empty name (the preview reports it); a file with no card fails loud', () => {
    expect(parseVcards('BEGIN:VCARD\nVERSION:3.0\nEMAIL:a@b.example\nEND:VCARD')[0]).toMatchObject({ name: '' })
    expect(() => parseVcards('name,email\nMara,mara@x.example')).toThrow(/no vCard/)
    expect(() => parseVcards('BEGIN:VCARD\nFN:Mara')).toThrow(/END:VCARD/)
  })
})

describe('parseCsv', () => {
  it('reads quoted fields with separators, quotes and line breaks; CRLF; a BOM; the separator you pick', () => {
    expect(parseCsv('\uFEFFname,note\r\n"Voss, Mara","said ""hi""\nthen left"\r\nJon,\r\n', ',')).toEqual([
      ['name', 'note'],
      ['Voss, Mara', 'said "hi"\nthen left'],
      ['Jon', ''],
    ])
    expect(parseCsv('a;b\n1;2', ';')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(parseCsv('a\tb\n1\t2', '\t')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('skips empty lines; an unclosed quote fails loud', () => {
    expect(parseCsv('a,b\n\n1,2\n', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(() => parseCsv('a,"b\n1,2', ',')).toThrow(/quote/)
  })
})

describe('the CSV column mapping (the person’s choice)', () => {
  const rows = [
    ['First', 'Last', 'Company', 'Mail', 'Mail 2', 'Phone', 'Labels', 'Junk'],
    ['Mara', 'Voss', 'Northwind', 'mara@northwind.example', '', '+49 30 1234', 'investor; Berlin', 'x'],
    ['Jon', '', '', 'jon@atelier.example', 'jon@home.example', '', '', 'y'],
  ]
  const mapping = ['firstName', 'lastName', 'organisation', 'email', 'email', 'phone', 'tags', 'ignore'] as const

  it('turns the rows into contacts as mapped; a header row is not a contact; empty cells are nothing', () => {
    expect(csvCandidates(rows, [...mapping], { headerRow: true })).toEqual([
      {
        name: 'Mara Voss',
        organisation: 'Northwind',
        title: null,
        channels: [
          { type: 'email', value: 'mara@northwind.example' },
          { type: 'phone', value: '+49 30 1234' },
        ],
        metHow: null,
        whyRelevant: null,
        tags: ['investor', 'Berlin'],
      },
      {
        name: 'Jon',
        organisation: null,
        title: null,
        channels: [
          { type: 'email', value: 'jon@atelier.example' },
          { type: 'email', value: 'jon@home.example' },
        ],
        metHow: null,
        whyRelevant: null,
        tags: [],
      },
    ])
    expect(csvCandidates(rows, [...mapping], { headerRow: false })).toHaveLength(3)
  })

  it('a full-name column wins over first + last', () => {
    expect(csvCandidates([['Mara V.', 'Mara', 'Voss']], ['name', 'firstName', 'lastName'], { headerRow: false })[0]!.name).toBe('Mara V.')
  })

  it('says what is missing or doubled before anything is read', () => {
    expect(checkMapping(['ignore', 'email'])).toEqual(['Pick the column with the name (or the first and last name).'])
    expect(checkMapping(['name', 'organisation', 'organisation'])).toEqual(['Only one column can be Organisation.'])
    expect(checkMapping(['firstName', 'email', 'email', 'tags', 'tags'])).toEqual([])
    expect(() => csvCandidates(rows, Array(8).fill('ignore'), { headerRow: true })).toThrow(/name/)
    expect(() => csvCandidates(rows, ['name'], { headerRow: true })).toThrow(/8 columns/)
  })
})
