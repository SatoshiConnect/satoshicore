// The world screen has its own title so an installed app window and a browser
// tab both say where the person is, and so the manifest shortcut lands on a
// route that names itself.
export const metadata = {
  title: 'Pixel World — SatoshiCore',
  description: 'Walk a pixel city, meet other characters and pay a verified wallet. Read-only development view for now.',
};

export const viewport = {
  themeColor: '#0a0c11',
};

export default function WorldLayout({ children }) {
  return children;
}
