<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/branding/Bulwark_Logo_with_Lettering_White_and_Color.svg" />
  <source media="(prefers-color-scheme: light)" srcset="public/branding/Bulwark_Logo_with_Lettering_Dark_Color.svg" />
  <img src="public/branding/Bulwark_Logo_with_Lettering_Dark_Color.svg" alt="Bulwark Webmail" width="280" />
</picture>

</div>

# Contributing to Bulwark Webmail

We're writing the webmail we wanted in 2026 and didn't find. Modern protocol, modern tooling, modern UI. Not a SaaS. Not a startup. Not for sale.

If that resonates with you, we'd love your help. This guide covers how to get the project running, the conventions we follow, and how to land your first change.

## Join the Community

You don't need to be an expert to contribute. Whether you're setting up your dev environment for the first time, filing a bug, or translating a string, the Discord is the fastest way to get unstuck and meet the people working on this.

- **Get support** - real-time help with development hurdles
- **Share ideas** - feature suggestions, design feedback, doc improvements
- **Collaborate** - meet the team and other contributors

[**Join the Bulwark Discord Server**](https://discord.gg/tYCujymGrT)

---

## Getting Started

### Development Setup

1. **Fork and clone** the repository:

   ```bash
   git clone https://github.com/bulwarkmail/webmail.git
   cd webmail
   ```

2. **Install dependencies**:

   ```bash
   npm install
   ```

3. **Set up environment**:

   ```bash
   cp .env.example .env.local
   # Edit .env.local with your JMAP server URL
   ```

4. **Start development server**:
   ```bash
   npm run dev
   ```

### Code Quality

Before submitting a pull request, ensure your code passes all checks:

```bash
# Type checking
npm run typecheck

# Linting
npm run lint

# Fix lint issues automatically
npm run lint:fix
```

These checks run automatically on commit via Husky pre-commit hooks.

## Code Style Guidelines

### TypeScript

- Use TypeScript for all new code
- Define proper types and interfaces
- Avoid `any` types when possible
- Use meaningful variable and function names

### React Components

- Use functional components with hooks
- Keep components focused and single-purpose
- Extract reusable logic into custom hooks
- Place components in appropriate directories under `/components`

### Styling

- Use Tailwind CSS utility classes
- Follow the existing design system
- Support both dark and light themes
- Use CSS variables for theme colors

## Internationalization (i18n)

This project uses **next-intl**. English (`/locales/en/common.json`) is the source of truth; we ship 15 additional locales (cs, de, es, fr, it, ja, ko, lv, nl, pl, pt, ru, tr, uk, zh).

### Rules

1. **Never hardcode user-facing text** - always use translations:

   ```tsx
   const t = useTranslations("namespace");
   return <div>{t("key")}</div>;
   ```

2. **Add new keys to `en/common.json` first.** Other locales can follow in the same PR or a follow-up - missing keys fall back to English.

3. **Namespace organization**:
   - `login.*` - login page
   - `sidebar.*` - sidebar navigation
   - `email_list.*` - email list
   - `email_viewer.*` - email viewer
   - `email_composer.*` - composer
   - `settings.*` - settings page
   - `notifications.*` - toasts and alerts
   - `common.*` - shared strings

4. **Locale-aware navigation**:

   ```tsx
   router.push(`/${params.locale}/settings`);
   ```

## Pull Request Process

### Before Submitting

1. **Create a feature branch**:

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** following the code style guidelines

3. **Test your changes** thoroughly

4. **Update translations** if you added user-facing text

5. **Run all checks**:
   ```bash
   npm run typecheck && npm run lint
   ```

### Submitting

1. **Push your branch** to your fork

2. **Open a Pull Request** with:
   - Clear title describing the change
   - Description of what was changed and why
   - Screenshots for UI changes
   - Reference to any related issues

### Commit Message Convention

Follow the conventional commits format:

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

Examples:

```
feat: add email threading support
fix: resolve attachment download issue
docs: update README with keyboard shortcuts
```

## Project Structure

```
webmail/
├── app/                    # Next.js App Router pages
│   └── [locale]/          # Locale-aware routing
├── components/            # React components
│   ├── email/            # Email-related components
│   ├── layout/           # Layout components
│   ├── settings/         # Settings components
│   └── ui/               # Reusable UI components
├── contexts/             # React contexts
├── hooks/                # Custom React hooks
├── lib/                  # Utilities and libraries
│   └── jmap/            # JMAP client implementation
├── locales/              # Translation files
│   ├── en/              # English translations
│   └── fr/              # French translations
└── stores/               # Zustand state stores
```

## Security

- **Never commit secrets** - API keys, passwords, tokens, `.env*` files
- **Sanitize user input** and email content
- **Block external content** by default - privacy is the point
- **Report vulnerabilities privately** to bulwark@rbm.systems, not via public issues

## Questions?

Open an issue, search existing ones, or ask in Discord. Thanks for helping build the webmail we all wished existed.
