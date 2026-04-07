# Development Workflow

1. Create feature branches from staging: git checkout staging && git checkout -b feature/my-feature
2. Do your work, push the feature branch
3. Test using Vercel preview deployment
4. Merge to staging: git checkout staging && git merge feature/my-feature && git push
5. Test staging preview deployment
6. When ready for production: git checkout main && git merge staging && git push
7. Never push directly to main
